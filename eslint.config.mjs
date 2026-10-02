import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.webpack/**',
      '**/.serverless/**',
      '**/coverage/**',
      // sequelize-cli generates the migrations, so linting them would let a
      // freshly generated file fail CI.
      'db/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The codebase still carries eslint-disable comments for rules this config
    // does not enable (airbnb-style `camelcase`, `max-len`, `no-param-reassign`,
    // and the import/jest plugins). They are left in place as a record of intent
    // in case those rules are restored, so unused directives are not reported.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node builtins; the previous config got these from `env: node`.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // @ts-ignore is the agreed way to park a suppression until an upstream
      // type is fixed, `any` is still widespread, and unused vars are already
      // reported by the compiler.
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // Plain CommonJS: migrations, sequelize config, the webpack config and the
    // helper scripts are loaded by tools that require `module.exports`/`require`.
    files: ['**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
