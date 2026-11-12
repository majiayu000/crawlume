import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { ReadInput } from './GenericFunctions';
import {
	crawlumeApiTest,
	crawlumeRequest,
	createReadJob,
	downloadArtifact,
	listPublications,
	readOutput,
	waitForJob,
} from './GenericFunctions';

const readOptions = {
	displayName: 'Options',
	name: 'options',
	type: 'collection' as const,
	placeholder: 'Add Option',
	default: {},
	options: [
		{
			displayName: 'Allow Browser',
			name: 'browserAllowed',
			type: 'boolean' as const,
			default: false,
			description: 'Whether the Worker may fall back to a headless browser for JavaScript-rendered pages',
		},
		{
			displayName: 'Cache Mode',
			name: 'cacheMode',
			type: 'options' as const,
			options: [
				{ name: 'Prefer Cache', value: 'prefer-cache' },
				{ name: 'Live', value: 'live' },
				{ name: 'Cache Only', value: 'cache-only' },
			],
			default: 'prefer-cache',
		},
		{
			displayName: 'Max Cache Age (Seconds)',
			name: 'maxAgeSeconds',
			type: 'number' as const,
			typeOptions: { minValue: 1 },
			default: 900,
		},
		{
			displayName: 'Deadline (Seconds)',
			name: 'deadlineSeconds',
			type: 'number' as const,
			typeOptions: { minValue: 1, maxValue: 86400 },
			default: 120,
			description: 'Job deadline enforced by the control plane',
		},
		{
			displayName: 'Max Provider Attempts',
			name: 'maxProviderAttempts',
			type: 'number' as const,
			typeOptions: { minValue: 1 },
			default: 3,
		},
		{
			displayName: 'Max Document Bytes',
			name: 'maxDocumentBytes',
			type: 'number' as const,
			typeOptions: { minValue: 1 },
			default: 5000000,
		},
	],
};

const jobIdField = {
	displayName: 'Job ID',
	name: 'jobId',
	type: 'string' as const,
	required: true,
	default: '',
};

export class Crawlume implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Crawlume',
		name: 'crawlume',
		icon: 'file:../../icons/crawlume.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Read web pages as clean Markdown through a Crawlume control plane',
		defaults: { name: 'Crawlume' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'crawlumeApi', required: true, testedBy: 'crawlumeApiTest' }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Read Page',
						value: 'readPage',
						description: 'Read a URL and wait for its Markdown',
						action: 'Read a page',
					},
					{
						name: 'Start Read Job',
						value: 'startJob',
						description: 'Queue a read Job and return immediately',
						action: 'Start a read job',
					},
					{
						name: 'Get Job',
						value: 'getJob',
						description: 'Get the status of a Job',
						action: 'Get a job',
					},
					{
						name: 'Get Job Results',
						value: 'getResults',
						description: 'Get the published Artifacts of a Job, with their content',
						action: 'Get job results',
					},
					{
						name: 'Cancel Job',
						value: 'cancelJob',
						action: 'Cancel a job',
					},
				],
				default: 'readPage',
			},
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com/',
				displayOptions: { show: { operation: ['readPage', 'startJob'] } },
			},
			{ ...readOptions, displayOptions: { show: { operation: ['readPage', 'startJob'] } } },
			{ ...jobIdField, displayOptions: { show: { operation: ['getJob', 'getResults', 'cancelJob'] } } },
			{
				displayName: 'Download Content',
				name: 'downloadContent',
				type: 'boolean',
				default: true,
				description: 'Whether to download each cloud Artifact and return its Markdown',
				displayOptions: { show: { operation: ['getResults'] } },
			},
		],
	};

	methods = { credentialTest: { crawlumeApiTest } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		for (let index = 0; index < items.length; index++) {
			try {
				const operation = this.getNodeParameter('operation', index) as string;
				for (const json of await runOperation(this, operation, index)) {
					returnData.push({ json, pairedItem: { item: index } });
				}
			} catch (error) {
				// NodeOperationError returns its own instances as-is and keeps a NodeApiError's message.
				if (!this.continueOnFail()) throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: index });
				returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: index } });
			}
		}
		return [returnData];
	}
}

async function runOperation(context: IExecuteFunctions, operation: string, index: number): Promise<IDataObject[]> {
	if (operation === 'readPage' || operation === 'startJob') {
		const input: ReadInput = {
			url: context.getNodeParameter('url', index) as string,
			...(context.getNodeParameter('options', index, {}) as Omit<ReadInput, 'url'>),
		};
		const job = await createReadJob(context, input);
		if (operation === 'startJob') return [job];
		// Poll a little past the Job deadline so the control plane, not the node, decides the outcome.
		const finished = await waitForJob(context, String(job.id), (input.deadlineSeconds ?? 120) * 1_000 + 30_000);
		if (finished.status !== 'completed') {
			throw new NodeOperationError(
				context.getNode(),
				`Read Job ${String(finished.id)} ${String(finished.status)}: ${String(finished.error_code ?? 'no error code')}`,
				{ itemIndex: index },
			);
		}
		const publications = await listPublications(context, String(finished.id));
		const outputs: IDataObject[] = [];
		for (const publication of publications) {
			const content = await downloadArtifact(context, publication.artifact as IDataObject);
			if (content === null) continue;
			outputs.push(readOutput(finished, publication, content));
		}
		if (outputs.length === 0) {
			throw new NodeOperationError(
				context.getNode(),
				'The Job completed but published no cloud Artifact. Enable cloud Artifact storage on the control plane and Worker.',
				{ itemIndex: index },
			);
		}
		return outputs;
	}
	const jobId = encodeURIComponent(context.getNodeParameter('jobId', index) as string);
	if (operation === 'getJob') return [(await crawlumeRequest(context, 'GET', `/jobs/${jobId}`)).job as IDataObject];
	if (operation === 'cancelJob') {
		return [(await crawlumeRequest(context, 'POST', `/jobs/${jobId}/cancel`, { body: {} })).job as IDataObject];
	}
	if (operation === 'getResults') {
		const job = (await crawlumeRequest(context, 'GET', `/jobs/${jobId}`)).job as IDataObject;
		const download = context.getNodeParameter('downloadContent', index) as boolean;
		const outputs: IDataObject[] = [];
		for (const publication of await listPublications(context, String(job.id))) {
			const content = download ? await downloadArtifact(context, publication.artifact as IDataObject) : null;
			outputs.push(readOutput(job, publication, content));
		}
		return outputs;
	}
	throw new NodeOperationError(context.getNode(), `Unknown operation ${operation}`, { itemIndex: index });
}
