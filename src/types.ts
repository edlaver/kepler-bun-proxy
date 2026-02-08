export interface ProviderConfig {
  routePrefix: string;
  upstreamTemplate: string;
  defaultModel: string;
  modelAliases: Record<string, string>;
  disableStreaming: boolean;
  stripRequestProperties: string[];
  tokenLimitPerMinute: number;
}

export interface ProxyConfig {
  convertToken: boolean;
  tokenEndpoint: string;
  debugPath?: string;
  providers: Record<string, ProviderConfig>;
}

export interface AppConfig {
  environmentName: string;
  host: string;
  port: number;
  proxy: ProxyConfig;
}
