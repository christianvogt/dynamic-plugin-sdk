// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./types.d.ts" />

import '@patternfly/react-core/dist/styles/base.css';
import './app-minimal.css';

import { PluginLoader, PluginStore, PluginStoreProvider } from '@openshift/dynamic-plugin-sdk';
import * as React from 'react';
import { render } from 'react-dom';
import MinimalAppPage from './components/app-minimal/MinimalAppPage';
import ErrorBoundary from './components/common/ErrorBoundary';
import Loading from './components/common/Loading';
import PageHeader from './components/common/PageHeader';
import PageLayout from './components/common/PageLayout';
import { initSharedScope, getSharedScope } from './shared-scope';

const appContainer = document.getElementById('app');

render(<Loading />, appContainer);

// eslint-disable-next-line promise/catch-or-return, promise/always-return
initSharedScope().then(() => {
  const pluginLoader = new PluginLoader({ sharedScope: getSharedScope() });
  const pluginStore = new PluginStore();

  pluginLoader.registerPluginEntryCallback();
  pluginStore.setLoader(pluginLoader);

  render(
    <PluginStoreProvider store={pluginStore}>
      <ErrorBoundary>
        <PageLayout header={<PageHeader />}>
          <MinimalAppPage />
        </PageLayout>
      </ErrorBoundary>
    </PluginStoreProvider>,
    appContainer,
  );
});
