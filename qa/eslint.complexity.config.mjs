import tseslint from 'typescript-eslint';
export default [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { complexity: ['warn', 0] } }];
