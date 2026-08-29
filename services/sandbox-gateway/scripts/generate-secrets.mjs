import { randomBytes } from "node:crypto";

const enrollment = `gsk_${randomBytes(32).toString("base64url")}`;
const tokenSecret = randomBytes(48).toString("base64url");

process.stdout.write(`GROKKY_ENROLLMENT_TOKEN=${enrollment}\nGROKKY_TOKEN_SECRET=${tokenSecret}\n`);
