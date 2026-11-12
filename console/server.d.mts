import type { RequestListener, Server } from "node:http";

export function createConsoleListener(controlUrl: URL): RequestListener;
export function startConsoleServer(
  environment?: NodeJS.ProcessEnv,
): Promise<{ server: Server; origin: string }>;
