import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist', 'node_modules', 'test'] },
	{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
	n8nCommunityNodesPlugin.configs.recommended,
);
