import type { Db } from '@postroom/db';

export interface ApiConfig {
  /** Absolute path of the built web app, served as statics; unset in tests. */
  webDist: string | undefined;
  /** Public origin, e.g. https://mail.d3cloud.io — used for cookies and OIDC redirects. */
  webOrigin: string;
  revision: string;
}

export interface ApiDeps {
  db: Db;
  config: ApiConfig;
  env: NodeJS.ProcessEnv;
}
