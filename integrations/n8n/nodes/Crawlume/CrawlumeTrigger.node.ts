import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { crawlumeApiTest, crawlumeRequest, verifyWebhookSignature } from './GenericFunctions';

export class CrawlumeTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Crawlume Trigger',
		name: 'crawlumeTrigger',
		icon: 'file:../../icons/crawlume.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when a Crawlume Job finishes',
		defaults: { name: 'Crawlume Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'crawlumeApi', required: true, testedBy: 'crawlumeApiTest' }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{ name: 'Job Completed', value: 'job.completed' },
					{ name: 'Job Failed', value: 'job.failed' },
					{ name: 'Job Cancelled', value: 'job.cancelled' },
				],
				default: ['job.completed'],
			},
			{
				displayName: 'Endpoint Registration',
				name: 'registration',
				type: 'options',
				options: [
					{
						name: 'Automatic',
						value: 'automatic',
						description: 'Register this webhook URL with Crawlume when the workflow is activated',
					},
					{
						name: 'Manual',
						value: 'manual',
						description: 'You registered the endpoint yourself and paste its signing secret below',
					},
				],
				default: 'automatic',
				description:
					'Crawlume only delivers to public https URLs, so automatic registration needs a publicly reachable n8n',
			},
			{
				displayName: 'Signing Secret',
				name: 'secret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				placeholder: 'whsec_…',
				description: 'Secret returned when the endpoint was created or rotated. Separate several with spaces.',
				displayOptions: { show: { registration: ['manual'] } },
			},
		],
	};

	methods = { credentialTest: { crawlumeApiTest } };

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				if (this.getNodeParameter('registration') === 'manual') return true;
				const staticData = this.getWorkflowStaticData('node');
				if (staticData.endpointId === undefined) return false;
				const { endpoints } = (await crawlumeRequest(this, 'GET', '/webhook-endpoints')) as {
					endpoints: IDataObject[];
				};
				const found = endpoints.some((endpoint) =>
					endpoint.id === staticData.endpointId &&
					endpoint.status === 'active' &&
					endpoint.url === this.getNodeWebhookUrl('default'));
				if (!found) {
					delete staticData.endpointId;
					delete staticData.secret;
				}
				return found;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				if (this.getNodeParameter('registration') === 'manual') return true;
				const response = await crawlumeRequest(this, 'POST', '/webhook-endpoints', {
					body: { url: this.getNodeWebhookUrl('default'), event_types: this.getNodeParameter('events') as string[] },
				});
				const staticData = this.getWorkflowStaticData('node');
				staticData.endpointId = (response.endpoint as IDataObject).id;
				staticData.secret = response.secret;
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				if (this.getNodeParameter('registration') === 'manual') return true;
				const staticData = this.getWorkflowStaticData('node');
				if (staticData.endpointId !== undefined) {
					try {
						await crawlumeRequest(this, 'DELETE', `/webhook-endpoints/${encodeURIComponent(String(staticData.endpointId))}`);
					} catch (error) {
						this.logger.warn(`Could not disable Crawlume webhook endpoint: ${(error as Error).message}`);
						return false;
					}
				}
				delete staticData.endpointId;
				delete staticData.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const secrets = this.getNodeParameter('registration') === 'manual'
			? String(this.getNodeParameter('secret')).split(/\s+/u).filter((secret) => secret.length > 0)
			: [String(this.getWorkflowStaticData('node').secret ?? '')];
		const failure = verifyWebhookSignature({
			secrets,
			headers: request.headers,
			body: request.rawBody?.toString('utf8') ?? '',
		});
		if (failure !== null) {
			this.getResponseObject().status(401).json({ error: failure });
			return { noWebhookResponse: true };
		}
		const event = this.getBodyData();
		const events = this.getNodeParameter('events') as string[];
		// Endpoints registered by hand may subscribe to more types than this node listens for.
		if (!events.includes(String(event.type))) return { webhookResponse: 'ignored' };
		return { workflowData: [this.helpers.returnJsonArray([event])] };
	}
}
