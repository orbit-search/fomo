import ts from 'typescript-eslint';
export default ts.config(
  { ignores: ['node_modules/**', 'dist/**', '.fomo/**'] },
  ...ts.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
