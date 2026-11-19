// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake control plane that follows the human-auth rules: Access Tokens live 10 minutes (plus 30 s
// clock tolerance), logout needs a valid one and clears the refresh cookie only when it succeeds.
const accessTokenTtlMs = 10 * 60 * 1_000;
const clockToleranceMs = 30_000;

type FakeControlPlane = {
  refreshCookieValid: boolean;
  requests: string[];
  /** Answers logout with this status instead of signing out, like a control plane that is down. */
  logoutFailure: number | null;
  /** Answers refresh with this status instead of rotating the cookie. */
  refreshFailure: number | null;
  /** Another tab signs out: every session of the user is revoked and the shared cookie is cleared. */
  signOutElsewhere(): void;
  /** Another tab signs in again: the shared cookie now belongs to a new session. */
  signInElsewhere(): void;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubControlPlane(refreshCookieValid: boolean): FakeControlPlane {
  const issued = new Map<string, number>();
  const state: FakeControlPlane = {
    refreshCookieValid,
    requests: [],
    logoutFailure: null,
    refreshFailure: null,
    signOutElsewhere: () => {
      issued.clear();
      state.refreshCookieValid = false;
    },
    signInElsewhere: () => {
      state.refreshCookieValid = true;
    },
  };
  let counter = 0;
  const issue = () => {
    const token = `token-${counter += 1}`;
    const expiresAt = Date.now() + accessTokenTtlMs;
    issued.set(token, expiresAt);
    return { token_type: "Bearer", access_token: token, access_token_expires_at: new Date(expiresAt).toISOString() };
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = input.split("?", 1)[0]!;
    state.requests.push(`${method} ${path}`);
    if (path === "/v1/auth/oidc/callback") {
      state.refreshCookieValid = true;
      return json(200, { ...issue(), user: { id: "user-1", email: "ada@example.com", display_name: "Ada" } });
    }
    if (path === "/v1/auth/refresh") {
      if (state.refreshFailure !== null) return json(state.refreshFailure, { code: "INTERNAL_ERROR" });
      return state.refreshCookieValid ? json(200, issue()) : json(401, { code: "REFRESH_TOKEN_INVALID" });
    }
    const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /u, "") ?? "";
    const expiresAt = issued.get(token);
    if (expiresAt === undefined || Date.now() > expiresAt + clockToleranceMs) {
      return json(401, { code: "ACCESS_TOKEN_INVALID" });
    }
    if (path === "/v1/auth/logout") {
      if (state.logoutFailure !== null) return json(state.logoutFailure, { code: "INTERNAL_ERROR" });
      issued.clear();
      state.refreshCookieValid = false;
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/organizations") {
      return json(200, { organizations: [], pagination: { next_cursor: null, has_more: false, limit: 100 } });
    }
    return json(404, { code: "NOT_FOUND" });
  }));
  return state;
}

function signOutButton(header: HTMLElement): HTMLButtonElement {
  const button = [...header.querySelectorAll("button")].find((item) => item.textContent === "Sign out");
  if (button === undefined) throw new Error("missing Sign out button");
  return button;
}

// From Node 25 Node defines its own localStorage global, which does not work without
// --localstorage-file and hides jsdom's. Give the console a working one in that case.
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, String(value));
    },
  };
}

if (typeof window.localStorage?.clear !== "function") {
  Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.body.innerHTML = '<header><div id="session"></div></header><main id="main"></main>';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("console session", () => {
  it("signs out for good after the Access Token has expired", async () => {
    const controlPlane = stubControlPlane(false);
    const api = await import("../console/src/api.js");
    await api.completeLogin("?state=state&code=code");

    vi.setSystemTime(Date.now() + accessTokenTtlMs + clockToleranceMs + 60_000);
    await api.logout();

    expect(controlPlane.refreshCookieValid).toBe(false);
    expect(await api.ensureSession()).toBe(false);
  });

  it("reports a refresh failure instead of signing out while the session may still be valid", async () => {
    const controlPlane = stubControlPlane(false);
    const api = await import("../console/src/api.js");
    await api.completeLogin("?state=state&code=code");

    vi.setSystemTime(Date.now() + accessTokenTtlMs + clockToleranceMs + 60_000);
    controlPlane.refreshFailure = 503;

    await expect(api.logout()).rejects.toMatchObject({ problem: { status: 503, code: "INTERNAL_ERROR" } });
    expect(controlPlane.refreshCookieValid).toBe(true);
  });

  it("offers Sign out in a tab that was signed in through the refresh cookie", async () => {
    const controlPlane = stubControlPlane(true);
    await import("../console/src/app.js");
    const header = document.getElementById("session")!;
    const main = document.getElementById("main")!;

    await vi.waitFor(() => expect(main.querySelector("h1")?.textContent).toBe("Projects"));
    const signOut = [...header.querySelectorAll("button")].find((button) => button.textContent === "Sign out");
    expect(signOut).toBeDefined();

    signOut!.click();
    await vi.waitFor(() => expect(main.querySelector("h1")?.textContent).toBe("Sign in"));
    expect(controlPlane.refreshCookieValid).toBe(false);
    expect(header.textContent).toBe("");
  });

  it("signs out a tab whose session another tab already signed out", async () => {
    const controlPlane = stubControlPlane(true);
    await import("../console/src/app.js");
    const header = document.getElementById("session")!;
    const main = document.getElementById("main")!;
    await vi.waitFor(() => expect(main.querySelector("h1")?.textContent).toBe("Projects"));

    window.sessionStorage.setItem("crawlume.console.api-key.project-1", "cr_live_secret");
    // The Access Token in this tab has not expired, but the control plane no longer accepts it.
    controlPlane.signOutElsewhere();
    signOutButton(header).click();

    await vi.waitFor(() => expect(main.querySelector("h1")?.textContent).toBe("Sign in"));
    expect(header.textContent).toBe("");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("signs out the new session when another tab signed out and in again", async () => {
    const controlPlane = stubControlPlane(true);
    await import("../console/src/app.js");
    const header = document.getElementById("session")!;
    const main = document.getElementById("main")!;
    await vi.waitFor(() => expect(main.querySelector("h1")?.textContent).toBe("Projects"));

    controlPlane.signOutElsewhere();
    controlPlane.signInElsewhere();
    signOutButton(header).click();

    await vi.waitFor(() => expect(main.querySelector("h1")?.textContent).toBe("Sign in"));
    expect(controlPlane.refreshCookieValid).toBe(false);
  });

  it("stays signed in and reports a logout the control plane could not complete", async () => {
    const controlPlane = stubControlPlane(true);
    await import("../console/src/app.js");
    const header = document.getElementById("session")!;
    const main = document.getElementById("main")!;
    await vi.waitFor(() => expect(main.querySelector("h1")?.textContent).toBe("Projects"));

    controlPlane.logoutFailure = 503;
    signOutButton(header).click();

    await vi.waitFor(() => expect(header.querySelector("[role='alert']")?.textContent).toContain("INTERNAL_ERROR"));
    expect(main.querySelector("h1")?.textContent).toBe("Projects");
    expect(controlPlane.refreshCookieValid).toBe(true);
  });
});
