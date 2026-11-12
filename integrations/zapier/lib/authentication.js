'use strict';

const { projectUrl } = require('./api');

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'baseUrl',
      label: 'Control Plane URL',
      required: true,
      type: 'string',
      helpText: 'Base URL of the Project Control API, including /v1, e.g. `https://control.example/v1`.',
    },
    { key: 'projectId', label: 'Project ID', required: true, type: 'string' },
    {
      key: 'apiKey',
      label: 'API Key',
      required: true,
      type: 'password',
      helpText: 'Project API key with tasks:write and results:read; the trigger also needs project:admin.',
    },
  ],
  // No API-key route lists Jobs, so probe a Job that cannot exist: 404 proves the key is valid for
  // this Project, while 401/403 mean a bad key or a key bound to another Project.
  test: async (z, bundle) => {
    const response = await z.request({
      url: projectUrl(bundle, '/jobs/00000000-0000-4000-8000-000000000000'),
      skipThrowForStatus: true,
    });
    if (response.status === 404) return { projectId: bundle.authData.projectId };
    let detail = `HTTP ${response.status}`;
    try {
      detail = JSON.parse(response.content).detail || detail;
    } catch {
      // Keep the status-only message.
    }
    throw new z.errors.Error(detail, 'AuthenticationError', response.status);
  },
  connectionLabel: 'Project {{bundle.authData.projectId}}',
};
