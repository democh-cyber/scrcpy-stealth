module.exports = {
  env: {
    browser: true,
    node: true,
    es2021: true,
  },
  root: true,
  extends: 'eslint:recommended',
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'module',
  },
  rules: {
    'no-unused-vars': ['warn', { vars: 'all', args: 'after-used', ignoreRestSiblings: true }],
    'no-console': 'off',
    'no-undef': 'warn',
  },
};
