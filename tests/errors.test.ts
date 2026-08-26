import { describe, expect, test } from "vitest";
import { userFacingError } from "../src/shared/errors";

describe("user-facing errors", () => {
  test("removes Electron IPC implementation details", () => {
    expect(userFacingError(
      new Error("Error invoking remote method 'grokky:message:send': Error: Choose Full access before sending it."),
      "Fallback",
    )).toBe("Choose Full access before sending it.");
  });
});
