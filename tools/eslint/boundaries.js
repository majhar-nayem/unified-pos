// Module-boundary rules for eslint-plugin-boundaries (v6 object selectors).
//
// Encodes docs/01-system-architecture.md §5 ("cross-module table access is forbidden",
// modules talk only through their public application-service interface) and
// docs/03-implementation-plan.md §2 ("apps/* → packages/*", "modules/<x> → modules/<y>/public only").
//
// Element types (first match wins, so the most specific patterns come first):
//   module-public  apps/<app>/src/modules/<module>/public/**   the module's public interface
//   module         apps/<app>/src/modules/<module>/**          module internals (services, repos, tables)
//   app            apps/<app>/**                               app shell: bootstrap, config, non-module code
//   package        packages/<pkg>/**                           shared workspace packages
//   tools          tools/**                                    codegen and lint tooling

/**
 * Allowed workspace-package dependencies. A package may import only the packages listed here
 * (plus itself and third-party modules). domain-core is pure and imports nothing from the workspace.
 */
export const PACKAGE_DEPENDENCIES = {
  'domain-core': [],
  contracts: ['domain-core'],
  db: ['contracts'],
  'sync-protocol': ['domain-core', 'contracts'],
  hardware: ['contracts'],
  'payments-sdk': ['domain-core', 'contracts'],
  ui: [],
  auth: ['contracts'],
  observability: [],
  testing: ['db', 'contracts', 'domain-core', 'auth'],
};

export const elements = [
  {
    type: 'module-public',
    pattern: 'apps/*/src/modules/*/public',
    mode: 'folder',
    capture: ['app', 'module'],
  },
  {
    type: 'module',
    pattern: 'apps/*/src/modules/*',
    mode: 'folder',
    capture: ['app', 'module'],
  },
  { type: 'app', pattern: 'apps/*', mode: 'folder', capture: ['app'] },
  { type: 'package', pattern: 'packages/*', mode: 'folder', capture: ['pkg'] },
  { type: 'tools', pattern: 'tools', mode: 'folder' },
];

// v6 selectors: `from` is an element selector; each allow entry is a dependency selector `{ to }`.
const pkg = (name) => ({ type: 'package', captured: { pkg: name } });
const anyPackage = { to: { type: 'package' } };
const sameApp = (type) => ({ to: { type, captured: { app: '{{from.captured.app}}' } } });

const packageRules = Object.entries(PACKAGE_DEPENDENCIES).map(([name, deps]) => ({
  from: pkg(name),
  allow: deps.map((dep) => ({ to: pkg(dep) })),
}));

export const dependencyRules = {
  default: 'disallow',
  message:
    '{{from.type}} "{{from.elementPath}}" may not import {{to.type}} "{{to.elementPath}}" (allowed imports: tools/eslint/boundaries.js)',
  rules: [
    // App shells (bootstrap, config) may use shared packages and the public surface of their own modules.
    {
      from: { type: 'app' },
      allow: [anyPackage, sameApp('module-public')],
    },
    // Module internals: shared packages and ONLY the public folder of modules (their own included).
    {
      from: { type: 'module' },
      allow: [anyPackage, sameApp('module-public')],
    },
    // A module's public folder may reach into its own internals (to re-export the Nest module and services)
    // and into other modules' public folders.
    {
      from: { type: 'module-public' },
      allow: [
        anyPackage,
        {
          to: {
            type: 'module',
            captured: { app: '{{from.captured.app}}', module: '{{from.captured.module}}' },
          },
        },
        sameApp('module-public'),
      ],
    },
    // Tooling may use packages.
    { from: { type: 'tools' }, allow: [anyPackage] },
    // Package-to-package matrix.
    ...packageRules,
  ],
};
