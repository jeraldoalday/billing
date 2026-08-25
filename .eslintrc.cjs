module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'build', 'node_modules', 'coverage', '**/generated/**'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': 'off',
  },
  overrides: [
    {
      // The web/ workspace is browser code: it needs the DOM globals and the
      // JSX parser option, neither of which apply to the Node server.
      files: ['web/**/*.ts', 'web/**/*.tsx'],
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      env: {
        browser: true,
        node: false,
      },
    },
  ],
};
