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
  // No API-key route lists Jobs, so probe a Job that cannot exist: 404 JOB_NOT_FOUND proves the key is
  // valid for this Project, while 401/403 mean a bad key or a key bound to another Project. Any other
  // 404 comes from routing before the key is checked (a Project ID that is not a UUID, a URL without /v1).
  test: async (z, bundle) => {
    const response = await z.request({
      url: projectUrl(bundle, '/jobs/00000000-0000-4000-8000-000000000000'),
      skipThrowForStatus: true,
    });
    let problem = {};
    try {
      problem = JSON.parse(response.content) || {};
    } catch {
      // Keep the status-only message.
    }
    if (response.status === 404 && problem.code === 'JOB_NOT_FOUND') return { projectId: bundle.authData.projectId };
    let detail = problem.detail || `HTTP ${response.status}`;
    if (response.status === 404) {
      detail += " Check that the Control Plane URL ends with /v1 and the Project ID is the Project's UUID.";
    }
    throw new z.errors.Error(detail, 'AuthenticationError', response.status);
  },
  connectionLabel: 'Project {{bundle.authData.projectId}}',
};
