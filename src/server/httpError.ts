export const httpError = (msg: string, statusCode: number): Error & { statusCode: number } =>
  Object.assign(new Error(msg), { statusCode });
