import { randomInt } from "node:crypto";

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ID_LENGTH = 8;

export function newId(): string {
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ID_CHARS[randomInt(ID_CHARS.length)];
  }
  return id;
}
