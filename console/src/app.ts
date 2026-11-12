import {
  allPages,
  ApiError,
  completeLogin,
  currentUser,
  ensureSession,
  forgetJob,
  human,
  logout,
  project,
  projectApiKey,
  recentJobs,
  rememberJob,
  setProjectApiKey,
  type ApiKey,
  type ApiKeyScope,
  type Job,
  type Organization,
  type Project,
  type Publication,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "./api.js";
import { formatBytes, formatTime, h, secretBox, table } from "./dom.js";

const main = document.getElementById("main")!;
const header = document.getElementById("session")!;
const scopes: ApiKeyScope[] = ["tasks:write", "results:read", "project:admin"];
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const projectsById = new Map<string, Project>();
let pollTimer: number | undefined;

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = error.problem.errors?.map((item) => `${item.field}: ${item.message}`).join("; ");
    return `${error.problem.code} — ${error.problem.detail}${fields ? ` (${fields})` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function errorBox(error: unknown): HTMLElement {
  return h("p", { class: "error", role: "alert" }, errorText(error));
}

/** Runs an action from a button or form and shows its failure next to the trigger. */
function guarded(slot: HTMLElement, action: () => Promise<void>): () => Promise<void> {
  return async () => {
    slot.replaceChildren();
    try {
      await action();
    } catch (error) {
      slot.replaceChildren(errorBox(error));
    }
  };
}

function navigate(hash: string): void {
  if (location.hash === hash) void render();
  else location.hash = hash;
}

function renderHeader(): void {
  const user = currentUser();
  header.replaceChildren(user === null ? "" : h("span", {},
    h("span", { class: "muted" }, user.display_name ?? user.email ?? user.id), " ",
    h("button", {
      type: "button",
      class: "link",
      onclick: async () => {
        await logout();
        navigate("#/");
      },
    }, "Sign out"),
  ));
}

function signInPage(): HTMLElement {
  return h("section", { class: "card narrow" },
    h("h1", {}, "Sign in"),
    h("p", {}, "Sign in with your organization's identity provider to manage Projects, API keys, Jobs and webhooks."),
    h("a", { class: "button", href: "/v1/auth/oidc/begin" }, "Sign in with OIDC"),
  );
}

async function loadProjects(): Promise<Array<{ organization: Organization; projects: Project[] }>> {
  const organizations = await allPages<Organization>("/organizations", "organizations");
  return Promise.all(organizations.map(async (organization) => {
    const projects = await allPages<Project>(`/organizations/${organization.id}/projects`, "projects");
    for (const item of projects) projectsById.set(item.id, item);
    return { organization, projects };
  }));
}

async function projectsPage(): Promise<HTMLElement> {
  const groups = await loadProjects();
  return h("section", {},
    h("h1", {}, "Projects"),
    ...groups.map(({ organization, projects }) => {
      const status = h("div");
      const form = h("form", { class: "row" },
        h("input", { name: "name", placeholder: "Project name", required: true, "aria-label": "Project name" }),
        h("input", { name: "slug", placeholder: "slug", required: true, pattern: "\\S+", "aria-label": "Project slug" }),
        h("button", { type: "submit" }, "Create project"),
      ) as HTMLFormElement;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const data = new FormData(form);
        void guarded(status, async () => {
          const { project: created } = await human<{ project: Project }>(
            "POST",
            `/organizations/${organization.id}/projects`,
            { name: data.get("name"), slug: data.get("slug") },
            { "idempotency-key": crypto.randomUUID() },
          );
          projectsById.set(created.id, created);
          navigate(`#/p/${created.id}/keys`);
        })();
      });
      return h("div", { class: "card" },
        h("h2", {}, organization.name, " ",
          h("span", { class: "badge" }, organization.kind), " ",
          h("span", { class: "badge" }, organization.role)),
        table(["Name", "Slug", "Created"], projects.map((item) => [
          h("a", { href: `#/p/${item.id}/keys` }, item.name),
          h("code", {}, item.slug),
          document.createTextNode(formatTime(item.created_at)),
        ]), "No projects yet."),
        organization.role === "member" ? null : form,
        status,
      );
    }),
  );
}

async function resolveProject(projectId: string): Promise<Project | null> {
  if (!projectsById.has(projectId)) await loadProjects();
  return projectsById.get(projectId) ?? null;
}

function projectNav(item: Project, active: string): HTMLElement {
  const tabs: Array<[string, string]> = [
    ["keys", "API keys"], ["jobs", "Jobs"], ["webhooks", "Webhooks"], ["usage", "Usage"],
  ];
  return h("div", {},
    h("p", { class: "muted" }, h("a", { href: "#/" }, "Projects"), " / ", item.slug),
    h("h1", {}, item.name),
    h("nav", { class: "tabs" }, ...tabs.map(([id, label]) =>
      h("a", { href: `#/p/${item.id}/${id}`, class: id === active ? "active" : undefined }, label))),
  );
}

/** Lets the person choose which Project API key this tab uses for Job and webhook routes. */
function apiKeyPanel(projectId: string, required: ApiKeyScope): HTMLElement {
  const key = projectApiKey(projectId);
  if (key !== null) {
    return h("p", { class: "muted" },
      `Using API key ${key.slice(0, 16)}… for this tab. `,
      h("button", {
        type: "button",
        class: "link",
        onclick: () => {
          setProjectApiKey(projectId, null);
          void render();
        },
      }, "Forget key"),
    );
  }
  const form = h("form", { class: "card" },
    h("p", {}, `These routes need a Project API key with the ${required} scope. Create one under `,
      h("a", { href: `#/p/${projectId}/keys` }, "API keys"), " or paste an existing secret."),
    h("div", { class: "row" },
      h("input", {
        name: "secret", type: "password", required: true, placeholder: "dya_live_…",
        autocomplete: "off", "aria-label": "API key secret",
      }),
      h("button", { type: "submit" }, "Use key in this tab"),
    ),
  ) as HTMLFormElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    setProjectApiKey(projectId, String(new FormData(form).get("secret")).trim());
    void render();
  });
  return form;
}

async function keysPage(item: Project): Promise<HTMLElement> {
  const keys = await allPages<ApiKey>(`/projects/${item.id}/api-keys`, "api_keys");
  const status = h("div");
  const reveal = h("div");

  const useButton = (secret: string) => h("button", {
    type: "button",
    onclick: () => {
      setProjectApiKey(item.id, secret);
      navigate(`#/p/${item.id}/jobs`);
    },
  }, "Use in this tab");

  const createKey = async (selected: ApiKeyScope[], expiresAt: string | null) =>
    human<{ api_key: ApiKey; secret: string }>("POST", `/projects/${item.id}/api-keys`, {
      scopes: selected,
      expires_at: expiresAt,
    });

  const refresh = async () => {
    main.replaceChildren(projectNav(item, "keys"), await keysPage(item));
  };

  const rows = keys.map((key) => {
    const active = key.revoked_at === null &&
      (key.expires_at === null || Date.parse(key.expires_at) > Date.now());
    return [
      h("code", {}, key.display_prefix),
      document.createTextNode(key.scopes.join(", ")),
      document.createTextNode(formatTime(key.created_at)),
      document.createTextNode(formatTime(key.last_used_at)),
      document.createTextNode(key.expires_at === null ? "never" : formatTime(key.expires_at)),
      key.revoked_at === null
        ? h("span", { class: active ? "badge ok" : "badge" }, active ? "active" : "expired")
        : h("span", { class: "badge bad" }, `revoked ${formatTime(key.revoked_at)}`),
      key.revoked_at !== null ? h("span") : h("span", { class: "row" },
        h("button", {
          type: "button",
          onclick: guarded(status, async () => {
            if (!confirm(`Rotate ${key.display_prefix}? A new key with the same scopes is created and this one is revoked.`)) return;
            const created = await createKey(key.scopes, key.expires_at);
            await human("DELETE", `/projects/${item.id}/api-keys/${key.id}`);
            if (projectApiKey(item.id)?.startsWith(key.display_prefix)) setProjectApiKey(item.id, null);
            await refresh();
            main.querySelector("#reveal")!.replaceChildren(secretBox(
              `Replacement for ${key.display_prefix}: ${created.api_key.display_prefix}`,
              created.secret,
              useButton(created.secret),
            ));
          }),
        }, "Rotate"),
        h("button", {
          type: "button",
          class: "danger",
          onclick: guarded(status, async () => {
            if (!confirm(`Revoke ${key.display_prefix}? Clients using it stop working immediately.`)) return;
            await human("DELETE", `/projects/${item.id}/api-keys/${key.id}`);
            if (projectApiKey(item.id)?.startsWith(key.display_prefix)) setProjectApiKey(item.id, null);
            await refresh();
          }),
        }, "Revoke"),
      ),
    ];
  });

  const form = h("form", { class: "card" },
    h("h2", {}, "Create API key"),
    h("div", { class: "row" }, ...scopes.map((scope) => h("label", {},
      h("input", { type: "checkbox", name: "scope", value: scope, checked: true }), ` ${scope}`))),
    h("label", {}, "Expires (optional) ",
      h("input", { type: "datetime-local", name: "expires_at", "aria-label": "Expiry" })),
    h("button", { type: "submit" }, "Create key"),
  ) as HTMLFormElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const selected = data.getAll("scope") as ApiKeyScope[];
    const expires = String(data.get("expires_at") ?? "");
    void guarded(status, async () => {
      if (selected.length === 0) throw new Error("Choose at least one scope.");
      const created = await createKey(selected, expires === "" ? null : new Date(expires).toISOString());
      await refresh();
      main.querySelector("#reveal")!.replaceChildren(secretBox(
        `New key ${created.api_key.display_prefix}`,
        created.secret,
        useButton(created.secret),
      ));
    })();
  });

  reveal.id = "reveal";
  return h("section", {},
    reveal,
    table(["Prefix", "Scopes", "Created", "Last used", "Expires", "State", ""], rows, "No API keys yet."),
    status,
    form,
  );
}

function jobStatusBadge(status: string): HTMLElement {
  const tone = status === "completed" ? "ok" : status === "failed" || status === "cancelled" ? "bad" : "";
  return h("span", { class: `badge ${tone}` }, status);
}

function jobTarget(job: Job): string {
  return String(job.input.url ?? job.input.query ?? "");
}

async function jobsPage(item: Project): Promise<HTMLElement> {
  const keyPanel = apiKeyPanel(item.id, "tasks:write");
  if (projectApiKey(item.id) === null) return h("section", {}, keyPanel);

  const status = h("div");
  const form = h("form", { class: "card" },
    h("h2", {}, "Create read Job"),
    h("div", { class: "row" },
      h("input", {
        name: "url", type: "url", required: true, placeholder: "https://example.com/",
        class: "grow", "aria-label": "URL",
      }),
      h("select", { name: "cache_mode", "aria-label": "Cache mode" },
        h("option", { value: "prefer-cache" }, "prefer-cache"),
        h("option", { value: "live" }, "live"),
        h("option", { value: "cache-only" }, "cache-only")),
      h("label", {}, h("input", { type: "checkbox", name: "browser" }), " browser"),
      h("button", { type: "submit" }, "Create Job"),
    ),
  ) as HTMLFormElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const browser = data.get("browser") === "on";
    void guarded(status, async () => {
      const { job } = await project<{ job: Job }>(item.id, "POST", "/jobs", {
        type: "read",
        input: {
          url: String(data.get("url")),
          browserAllowed: browser,
          cacheMode: String(data.get("cache_mode")),
        },
        data_class: "public",
        placement: { class: "public", pinned_worker_id: null },
        required_capabilities: browser ? { http: true, browser: true } : { http: true },
        budget: {
          deadline_ms: 120_000,
          max_provider_attempts: 3,
          max_document_bytes: 5_000_000,
          max_browser_ms: browser ? 60_000 : 0,
          max_browser_contexts: browser ? 1 : 0,
        },
        policy_version: "console",
        upload_private_artifact: false,
      }, { "idempotency-key": crypto.randomUUID() });
      rememberJob(item.id, job.id);
      navigate(`#/p/${item.id}/jobs/${job.id}`);
    })();
  });

  const lookup = h("form", { class: "row" },
    h("input", { name: "job_id", required: true, placeholder: "Job ID", class: "grow", "aria-label": "Job ID" }),
    h("button", { type: "submit" }, "Open Job"),
  ) as HTMLFormElement;
  lookup.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(`#/p/${item.id}/jobs/${String(new FormData(lookup).get("job_id")).trim()}`);
  });

  const ids = recentJobs(item.id);
  const jobs = await Promise.all(ids.map(async (id) => {
    try {
      return { id, job: (await project<{ job: Job }>(item.id, "GET", `/jobs/${id}`)).job, error: null };
    } catch (error) {
      return { id, job: null, error };
    }
  }));
  return h("section", {},
    keyPanel,
    form,
    status,
    h("h2", {}, "Recent Jobs"),
    h("p", { class: "muted" },
      "Jobs created or opened from this browser. The API has no Job listing route yet."),
    table(["Job", "Type", "Target", "Status", ""], jobs.map(({ id, job, error }) => [
      h("a", { href: `#/p/${item.id}/jobs/${id}` }, h("code", {}, id.slice(0, 8))),
      document.createTextNode(job?.type ?? "—"),
      document.createTextNode(job === null ? errorText(error) : jobTarget(job)),
      job === null ? h("span") : jobStatusBadge(job.status),
      h("button", {
        type: "button",
        class: "link",
        onclick: () => {
          forgetJob(item.id, id);
          void render();
        },
      }, "Hide"),
    ]), "No Jobs from this browser yet."),
    lookup,
  );
}

async function jobPage(item: Project, jobId: string): Promise<HTMLElement> {
  const keyPanel = apiKeyPanel(item.id, "results:read");
  if (projectApiKey(item.id) === null) return h("section", {}, keyPanel);
  const { job } = await project<{ job: Job }>(item.id, "GET", `/jobs/${jobId}`);
  rememberJob(item.id, job.id);
  const publications = await project<{ publications: Publication[] }>(
    item.id, "GET", `/jobs/${job.id}/publications?limit=100`,
  ).then((body) => body.publications, (error: unknown) => error);
  const status = h("div");

  const control = (action: "pause" | "resume" | "cancel", label: string, enabled: boolean) =>
    h("button", {
      type: "button",
      class: action === "cancel" ? "danger" : undefined,
      disabled: !enabled,
      onclick: guarded(status, async () => {
        if (action === "cancel" && !confirm("Cancel this Job?")) return;
        await project(item.id, "POST", `/jobs/${job.id}/${action}`, {});
        await render();
      }),
    }, label);

  const terminal = terminalStatuses.has(job.status);
  if (!terminal) pollTimer = window.setTimeout(() => { void render(); }, 3_000);

  const download = (publication: Publication) => publication.artifact.storage !== "cloud_object"
    ? h("span", { class: "muted" }, "kept on the Worker")
    : h("button", {
      type: "button",
      onclick: guarded(status, async () => {
        const { url } = await project<{ url: string }>(
          item.id, "GET", `/artifacts/${publication.artifact.id}/download`,
        );
        window.open(url, "_blank", "noopener");
      }),
    }, "Download");

  return h("section", {},
    keyPanel,
    h("div", { class: "card" },
      h("h2", {}, "Job ", h("code", {}, job.id), " ", jobStatusBadge(job.status)),
      h("dl", {},
        h("dt", {}, "Type"), h("dd", {}, job.type),
        h("dt", {}, "Target"), h("dd", {}, jobTarget(job)),
        h("dt", {}, "Result"), h("dd", {}, job.result_completeness ?? "—"),
        h("dt", {}, "Error"), h("dd", {}, job.error_code ?? "—"),
        h("dt", {}, "Priority"), h("dd", {}, job.priority),
        h("dt", {}, "Not before"), h("dd", {}, formatTime(job.not_before)),
        h("dt", {}, "Deadline"), h("dd", {}, formatTime(job.deadline_at)),
        h("dt", {}, "Policy"), h("dd", {}, job.policy_version),
      ),
      h("div", { class: "row" },
        control("pause", "Pause", !terminal && job.status !== "paused"),
        control("resume", "Resume", job.status === "paused"),
        control("cancel", "Cancel", !terminal),
        terminal ? null : h("span", { class: "muted" }, "Refreshing every 3 s…"),
      ),
      status,
    ),
    h("h2", {}, "Results"),
    Array.isArray(publications)
      ? table(["#", "Completeness", "Type", "Size", "Recorded", ""], publications.map((publication) => [
        document.createTextNode(String(publication.sequence)),
        document.createTextNode(publication.completeness),
        document.createTextNode(publication.artifact.media_type),
        document.createTextNode(formatBytes(publication.artifact.byte_count)),
        document.createTextNode(formatTime(publication.recorded_at)),
        download(publication),
      ]), terminal ? "This Job published no results." : "No results yet.")
      : errorBox(publications),
    h("details", {}, h("summary", {}, "Raw Job"), h("pre", {}, JSON.stringify(job, null, 2))),
  );
}

async function webhooksPage(item: Project): Promise<HTMLElement> {
  const keyPanel = apiKeyPanel(item.id, "project:admin");
  if (projectApiKey(item.id) === null) return h("section", {}, keyPanel);
  const [{ endpoints }, { deliveries }] = await Promise.all([
    project<{ endpoints: WebhookEndpoint[] }>(item.id, "GET", "/webhook-endpoints"),
    project<{ deliveries: WebhookDelivery[] }>(item.id, "GET", "/webhook-deliveries?limit=50"),
  ]);
  const status = h("div");
  const reveal = h("div");
  const eventTypes = ["job.completed", "job.failed", "job.cancelled"];

  const form = h("form", { class: "card" },
    h("h2", {}, "Add endpoint"),
    h("div", { class: "row" },
      h("input", {
        name: "url", type: "url", required: true, placeholder: "https://hooks.example.com/crawlume",
        class: "grow", "aria-label": "Endpoint URL",
      }),
      ...eventTypes.map((type) => h("label", {},
        h("input", { type: "checkbox", name: "event_type", value: type, checked: true }), ` ${type}`)),
      h("button", { type: "submit" }, "Add endpoint"),
    ),
  ) as HTMLFormElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    void guarded(status, async () => {
      const created = await project<{ endpoint: WebhookEndpoint; secret: string }>(
        item.id, "POST", "/webhook-endpoints",
        { url: String(data.get("url")), event_types: data.getAll("event_type") },
      );
      await render();
      main.querySelector("#reveal")!.replaceChildren(
        secretBox(`Signing secret for ${created.endpoint.url}`, created.secret));
    })();
  });

  reveal.id = "reveal";
  return h("section", {},
    keyPanel,
    reveal,
    h("h2", {}, "Endpoints"),
    table(["URL", "Events", "Status", "Created", ""], endpoints.map((endpoint) => [
      h("code", {}, endpoint.url),
      document.createTextNode(endpoint.event_types.join(", ")),
      h("span", { class: endpoint.status === "active" ? "badge ok" : "badge" }, endpoint.status),
      document.createTextNode(formatTime(endpoint.created_at)),
      endpoint.status !== "active" ? h("span") : h("span", { class: "row" },
        h("button", {
          type: "button",
          onclick: guarded(status, async () => {
            const { secret } = await project<{ secret: string }>(
              item.id, "POST", `/webhook-endpoints/${endpoint.id}/rotate-secret`, {},
            );
            reveal.replaceChildren(secretBox(
              `New signing secret for ${endpoint.url} (the old one keeps signing for 24 hours)`, secret));
          }),
        }, "Rotate secret"),
        h("button", {
          type: "button",
          class: "danger",
          onclick: guarded(status, async () => {
            if (!confirm(`Disable ${endpoint.url}?`)) return;
            await project(item.id, "DELETE", `/webhook-endpoints/${endpoint.id}`);
            await render();
          }),
        }, "Disable"),
      ),
    ]), "No webhook endpoints."),
    status,
    form,
    h("h2", {}, "Recent deliveries"),
    table(["Event", "Endpoint", "Status", "Attempts", "Last response", "Created", ""],
      deliveries.map((delivery) => [
        document.createTextNode(delivery.event_type),
        h("code", {}, delivery.endpoint_id.slice(0, 8)),
        h("span", {
          class: delivery.status === "succeeded" ? "badge ok"
            : delivery.status === "dead_letter" ? "badge bad" : "badge",
        }, delivery.status),
        document.createTextNode(String(delivery.attempt_count)),
        document.createTextNode(delivery.last_error ?? String(delivery.last_status_code ?? "—")),
        document.createTextNode(formatTime(delivery.created_at)),
        delivery.status !== "dead_letter" ? h("span") : h("button", {
          type: "button",
          onclick: guarded(status, async () => {
            await project(item.id, "POST", `/webhook-events/${delivery.event_id}/redeliver`, {});
            await render();
          }),
        }, "Redeliver"),
      ]), "No deliveries yet."),
  );
}

async function usagePage(item: Project): Promise<HTMLElement> {
  const keys = await allPages<ApiKey>(`/projects/${item.id}/api-keys`, "api_keys");
  const lastUsed = keys.map((key) => key.last_used_at).filter((value) => value !== null).sort().at(-1);
  return h("section", {},
    h("div", { class: "card" },
      h("h2", {}, "Quotas"),
      h("p", {},
        "Quota limits are set per deployment with the DIAOYAN_QUOTA_* environment variables and are "
        + "applied to every Project. The control-plane API does not expose limits or current usage yet, "
        + "so this console cannot show them. When a limit is reached, Job creation and API calls fail "
        + "with QUOTA_EXCEEDED, and the console shows that error where it happens."),
      table(["Quota", "Environment variable", "Counted as"], [
        ["Active Jobs", "DIAOYAN_QUOTA_ACTIVE_JOBS", "Jobs not yet completed, failed or cancelled"],
        ["Provider attempts / month", "DIAOYAN_QUOTA_MONTHLY_PROVIDER_ATTEMPTS", "Budget reserved by Jobs created this UTC month"],
        ["Browser minutes / month", "DIAOYAN_QUOTA_MONTHLY_BROWSER_MINUTES", "Browser budget reserved by Jobs created this UTC month"],
        ["Artifact bytes", "DIAOYAN_QUOTA_ARTIFACT_BYTES", "Stored cloud Artifact bytes"],
        ["API requests / minute", "DIAOYAN_QUOTA_API_REQUESTS_PER_MINUTE", "Requests per API key"],
      ].map((cells) => cells.map((cell) => document.createTextNode(cell))), ""),
    ),
    h("div", { class: "card" },
      h("h2", {}, "API key activity"),
      h("dl", {},
        h("dt", {}, "Keys"), h("dd", {}, keys.length),
        h("dt", {}, "Active keys"), h("dd", {}, keys.filter((key) => key.revoked_at === null).length),
        h("dt", {}, "Last API key use"), h("dd", {}, formatTime(lastUsed ?? null)),
      ),
    ),
  );
}

async function render(): Promise<void> {
  window.clearTimeout(pollTimer);
  renderHeader();
  const route = location.hash.replace(/^#/u, "").split("/").filter(Boolean);
  try {
    if (!await ensureSession()) {
      renderHeader();
      main.replaceChildren(signInPage());
      return;
    }
    renderHeader();
    if (route[0] !== "p" || route[1] === undefined) {
      main.replaceChildren(await projectsPage());
      return;
    }
    const item = await resolveProject(route[1]);
    if (item === null) {
      main.replaceChildren(h("p", { class: "error" }, "Project not found."), h("a", { href: "#/" }, "Back to Projects"));
      return;
    }
    const tab = route[2] ?? "keys";
    const content = tab === "jobs" && route[3] !== undefined ? await jobPage(item, route[3])
      : tab === "jobs" ? await jobsPage(item)
      : tab === "webhooks" ? await webhooksPage(item)
      : tab === "usage" ? await usagePage(item)
      : await keysPage(item);
    main.replaceChildren(projectNav(item, tab), content);
  } catch (error) {
    main.replaceChildren(errorBox(error), h("a", { href: "#/" }, "Back to Projects"));
  }
}

async function start(): Promise<void> {
  if (location.pathname === "/callback") {
    try {
      await completeLogin(location.search);
      history.replaceState(null, "", "/#/");
    } catch (error) {
      history.replaceState(null, "", "/");
      main.replaceChildren(errorBox(error), signInPage());
      return;
    }
  }
  window.addEventListener("hashchange", () => { void render(); });
  await render();
}

void start();
