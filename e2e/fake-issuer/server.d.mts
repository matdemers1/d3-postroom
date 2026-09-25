export interface FakeIssuerUser {
  sub: string;
  email?: string;
  name?: string;
  roles?: string[];
}

export interface FakeIssuerOptions {
  port?: number;
  host?: string;
  clientId?: string;
  clientSecret?: string;
  user?: FakeIssuerUser;
}

export interface FakeIssuer {
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly stats: { authorize: number; token: number };
  setUser(user: FakeIssuerUser): void;
  logoutToken(sub: string, extra?: Record<string, unknown>): string;
  close(): Promise<void>;
}

export declare function startFakeIssuer(options?: FakeIssuerOptions): Promise<FakeIssuer>;
