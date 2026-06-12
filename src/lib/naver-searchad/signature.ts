import { createHmac } from "crypto";

export function createNaverSearchAdSignature(timestamp: string, method: string, uri: string, secretKey: string) {
  const message = `${timestamp}.${method}.${uri}`;

  return createHmac("sha256", secretKey).update(message).digest("base64");
}
