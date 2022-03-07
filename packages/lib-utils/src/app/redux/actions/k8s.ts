import { consoleLogger } from '@monorepo/common';
import * as _ from 'lodash-es';
import type { Dispatch } from 'redux';
import type { ActionType as Action } from 'typesafe-actions';
import { action } from 'typesafe-actions';
import { k8sListResource, k8sGetResource } from '../../../k8s/k8s-resource';
import { k8sWatch } from '../../../k8s/k8s-utils';
import type { DiscoveryResources } from '../../../types/api-discovery';
import type { K8sModelCommon, K8sResourceCommon, FilterValue } from '../../../types/k8s';
import type { DispatchWithThunk, GetState } from '../../../types/redux';
import type { WebSocketFactory } from '../../../webSocket/WebSocketFactory';
import { getImpersonate, getActiveCluster } from '../reducers/core/selector';

export enum ActionType {
  ReceivedResources = 'resources',
  GetResourcesInFlight = 'getResourcesInFlight',
  StartWatchK8sObject = 'startWatchK8sObject',
  StartWatchK8sList = 'startWatchK8sList',
  ModifyObject = 'modifyObject',
  StopWatchK8s = 'stopWatchK8s',

  Errored = 'errored',
  Loaded = 'loaded',
  BulkAddToList = 'bulkAddToList',
  UpdateListFromWS = 'updateListFromWS',
  FilterList = 'filterList',
}

type K8sEvent = { type: 'ADDED' | 'DELETED' | 'MODIFIED'; object: K8sResourceCommon };

export const updateListFromWS = (id: string, k8sObjects: K8sEvent[]) =>
  action(ActionType.UpdateListFromWS, { id, k8sObjects });
export const loaded = (id: string, k8sObjects: K8sResourceCommon[]) =>
  action(ActionType.Loaded, { id, k8sObjects });

export const bulkAddToList = (id: string, k8sObjects: K8sResourceCommon[]) =>
  action(ActionType.BulkAddToList, { id, k8sObjects });

export const startWatchK8sObject = (id: string) => action(ActionType.StartWatchK8sObject, { id });
export const startWatchK8sList = (id: string, query: { [key: string]: string }) =>
  action(ActionType.StartWatchK8sList, { id, query });
export const modifyObject = (id: string, k8sObjects: K8sResourceCommon) =>
  action(ActionType.ModifyObject, { id, k8sObjects });
export const stopWatchK8s = (id: string) => action(ActionType.StopWatchK8s, { id });

export const errored = (id: string, k8sObjects: unknown) =>
  action(ActionType.Errored, { id, k8sObjects });
export const filterList = (id: string, name: string, value: FilterValue) =>
  action(ActionType.FilterList, { id, name, value });
type LoadedAction = typeof loaded;

export const partialObjectMetadataListHeader = {
  Accept: 'application/json;as=PartialObjectMetadataList;v=v1;g=meta.k8s.io,application/json',
};

export const partialObjectMetadataHeader = {
  Accept: 'application/json;as=PartialObjectMetadata;v=v1;g=meta.k8s.io,application/json',
};

// TODO create a helper class that can help manage these objects
const WS: { [id: string]: WebSocketFactory } = {};
const POLLs: { [id: string]: number } = {};
const REF_COUNTS: { [id: string]: number } = {};

const paginationLimit = 250;

export const stopK8sWatch =
  (id: string) =>
  (dispatch: Dispatch): void => {
    REF_COUNTS[id] -= 1;
    if (REF_COUNTS[id] > 0) {
      return;
    }

    const ws = WS[id];
    if (ws) {
      ws.destroy();
      delete WS[id];
    }
    const poller = POLLs[id];
    window.clearInterval(poller);
    delete POLLs[id];
    delete REF_COUNTS[id];
    dispatch(stopWatchK8s(id));
  };

export const watchK8sList =
  (
    id: string,
    query: { [key: string]: string },
    k8skind: K8sModelCommon,
    extraAction?: LoadedAction,
    partialMetadata = false,
  ) =>
  (dispatch: DispatchWithThunk, getState: GetState): void => {
    // Only one watch per unique list ID
    if (id in REF_COUNTS) {
      REF_COUNTS[id] += 1;
      return;
    }

    const queryWithCluster = query;
    if (!queryWithCluster.cluster) {
      queryWithCluster.cluster = getActiveCluster(getState());
    }
    dispatch(startWatchK8sList(id, queryWithCluster));
    REF_COUNTS[id] = 1;

    const incrementallyLoad = async (continueToken = ''): Promise<string | undefined> => {
      // the list may not still be around...
      if (!REF_COUNTS[id]) {
        // let .then handle the cleanup
        return undefined;
      }

      const requestOptions: RequestInit = partialMetadata
        ? {
            headers: partialObjectMetadataListHeader,
          }
        : {};

      const response = await k8sListResource({
        model: k8skind,
        queryOptions: {
          queryParams: {
            limit: `${paginationLimit}`,
            ...queryWithCluster,
            ...(continueToken ? { continue: continueToken } : {}),
          },
        },
        fetchOptions: {
          requestInit: requestOptions,
        },
      });

      if (!REF_COUNTS[id]) {
        return undefined;
      }

      if (!continueToken) {
        [loaded, extraAction].forEach((f) => f && dispatch(f(id, response.items)));
      } else {
        dispatch(bulkAddToList(id, response.items));
      }

      if (response.metadata.continue) {
        return incrementallyLoad(response.metadata.continue);
      }
      return response.metadata.resourceVersion;
    };
    /**
     * Incrementally fetch list (XHR) using k8s pagination then use its resourceVersion to
     *  start listening on a WS (?resourceVersion=$resourceVersion)
     *  start the process over when:
     *   1. the WS closes abnormally
     *   2. the WS can not establish a connection within $TIMEOUT
     */
    const pollAndWatch = async () => {
      delete POLLs[id];

      try {
        const resourceVersion = await incrementallyLoad();
        // ensure this watch should still exist because pollAndWatch is recursiveish
        if (!REF_COUNTS[id]) {
          consoleLogger.info(`stopped watching ${id} before finishing incremental loading.`);
          // call cleanup function out of abundance of caution...
          dispatch(stopK8sWatch(id));
          return;
        }

        if (WS[id]) {
          consoleLogger.warn(`Attempted to create multiple websockets for ${id}.`);
          return;
        }

        if (!_.get(k8skind, 'verbs', ['watch']).includes('watch')) {
          consoleLogger.warn(
            'Resource does not support watching, falling back to polling.',
            k8skind,
          );
          if (!POLLs[id]) {
            POLLs[id] = window.setTimeout(pollAndWatch, 15 * 1000);
          }
          return;
        }

        const { subprotocols } = getImpersonate(getState()) || {};
        WS[id] = k8sWatch(
          k8skind,
          { ...queryWithCluster, resourceVersion },
          { subProtocols: subprotocols, timeout: 60 * 1000 },
        );
      } catch (e) {
        if (!REF_COUNTS[id]) {
          consoleLogger.error(
            `stopped watching ${id} before finishing incremental loading with error ${e}!`,
          );
          // call cleanup function out of abundance of caution...
          dispatch(stopK8sWatch(id));
          return;
        }

        dispatch(errored(id, e));

        if (!POLLs[id]) {
          POLLs[id] = window.setTimeout(pollAndWatch, 15 * 1000);
        }
        return;
      }

      WS[id]
        .onClose((event: { code: number }) => {
          // Close Frame Status Codes: https://tools.ietf.org/html/rfc6455#section-7.4.1
          if (event.code !== 1006) {
            return;
          }
          consoleLogger.info('WS closed abnormally - starting polling loop over!');
          const ws = WS[id];
          ws?.destroy();
        })
        .onDestroy((timedOut: boolean) => {
          if (!timedOut) {
            return;
          }
          // If the WS is unsucessful for timeout duration, assume it is less work
          //  to update the entire list and then start the WS again

          consoleLogger.info(`${id} timed out - restarting polling`);
          delete WS[id];

          if (POLLs[id]) {
            return;
          }

          POLLs[id] = window.setTimeout(pollAndWatch, 15 * 1000);
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .onBulkMessage((events: any) =>
          [updateListFromWS, extraAction].forEach((f) => f && dispatch(f(id, events))),
        );
    };
    pollAndWatch();
  };

export const watchK8sObject =
  (
    id: string,
    name: string,
    namespace: string,
    query: { [key: string]: string },
    k8sType: K8sModelCommon,
    partialMetadata = false,
  ) =>
  (dispatch: Dispatch, getState: GetState): void => {
    if (id in REF_COUNTS) {
      REF_COUNTS[id] += 1;
      return;
    }
    dispatch(startWatchK8sObject(id));
    REF_COUNTS[id] = 1;

    const queryWithCluster = query;
    if (!queryWithCluster.cluster) {
      queryWithCluster.cluster = getActiveCluster(getState());
    }

    if (queryWithCluster.name) {
      queryWithCluster.fieldSelector = `metadata.name=${queryWithCluster.name}`;
      delete queryWithCluster.name;
    }

    const requestOptions: RequestInit = partialMetadata
      ? {
          headers: partialObjectMetadataHeader,
        }
      : {};

    const poller = () => {
      k8sGetResource({
        model: k8sType,
        queryOptions: {
          name,
          ns: namespace,
          queryParams: { cluster: queryWithCluster.cluster },
        },
        fetchOptions: {
          requestInit: requestOptions,
        },
      })
        .then(
          (o: K8sResourceCommon) => dispatch(modifyObject(id, o)),
          (e: unknown) => dispatch(errored(id, e)),
        )
        .catch((err: Error) => {
          consoleLogger.error(err);
        });
    };
    POLLs[id] = window.setInterval(poller, 30 * 1000);
    poller();

    if (!_.get(k8sType, 'verbs', ['watch']).includes('watch')) {
      consoleLogger.warn('Resource does not support watching', k8sType);
      return;
    }

    const { subprotocols } = getImpersonate(getState()) || {};

    WS[id] = k8sWatch(k8sType, queryWithCluster, { subProtocols: subprotocols }).onBulkMessage(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (events: any) =>
        events.forEach((e: { object: K8sResourceCommon }) => dispatch(modifyObject(id, e.object))),
    );
  };

export const receivedResources = (resources: DiscoveryResources) =>
  action(ActionType.ReceivedResources, { resources });
export const getResourcesInFlight = () => action(ActionType.GetResourcesInFlight);

const k8sActions = {
  startWatchK8sObject,
  startWatchK8sList,
  modifyObject,
  stopWatchK8s,
  errored,
  loaded,
  bulkAddToList,
  updateListFromWS,
  filterList,
  receivedResources,
  getResourcesInFlight,
};

export type K8sAction = Action<typeof k8sActions>;
