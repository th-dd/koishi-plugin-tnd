import { Context, Schema } from 'koishi';
export declare const name = "tomato-downloader";
export declare const inject: string[];
export interface Config {
    apiBase: string;
    apiPassword: string;
    enableImage?: boolean;
    imageWidth?: number;
    debug?: boolean;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
