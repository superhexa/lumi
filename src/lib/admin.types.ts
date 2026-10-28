export interface AdminConfig {
  SiteConfig: {
    SiteName: string;
    Announcement: string;
    SiteInterfaceCacheTime: number;
  };
  UserConfig: {
    Users: {
      username: string;
      role: 'user' | 'admin' | 'owner';
      banned?: boolean;
    }[];
  };
}

export interface AdminConfigResult {
  Role: 'owner' | 'admin';
  Config: AdminConfig;
}
