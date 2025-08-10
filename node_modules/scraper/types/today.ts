export type Today = {
  players: Array<{
    name: string;
    realm: string;
    level?: number;
    totalRP: number;
    levelPercent?: number | null;
    takenAt: string;
  }>;
  updatedAt: string;
};
