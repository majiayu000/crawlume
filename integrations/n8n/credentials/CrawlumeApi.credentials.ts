import type { IAuthenticateGeneric, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class CrawlumeApi implements ICredentialType {
	name = 'crawlumeApi';

	displayName = 'Crawlume API';

	icon: Icon = 'file:../icons/crawlume.svg';

	documentationUrl = 'https://github.com/majiayu000/crawlume/tree/main/integrations/n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Control Plane URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://control.example/v1',
			description: 'Base URL of the Project Control API, including the /v1 prefix',
			required: true,
		},
		{
			displayName: 'Project ID',
			name: 'projectId',
			type: 'string',
			default: '',
			description: 'The Project the API key belongs to',
			required: true,
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Project API key. Actions need tasks:write and results:read; the trigger also needs project:admin.',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
