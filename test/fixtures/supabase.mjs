import { createServer } from "node:http";
import { once } from "node:events";

export const mockPublishableKey = "sb_publishable_test";
export const mockSecretKey = "sb_secret_test";
const accounts = [
  { id: "patient-1", email: "patient@example.test", clinic: null },
  { id: "patient-2", email: "patient2@example.test", clinic: null },
  { id: "north-1", email: "north@example.test", clinic: "north" },
  { id: "south-1", email: "south@example.test", clinic: "south" }
];
const previousResult = {
  id: "previous-result", label: "Previous hemoglobin", text: "Hemoglobin · 11.6 g/dL"
};
const error = (status, message) => ({ status, message });
const expired = row => Date.parse(row.expires_at) <= Date.now();

function addEvent(row, kind, itemIds, at = new Date().toISOString()) {
  row.events.push({ kind, at, itemIds });
}

function referralDetails(row, account, { signed_pass, access_purpose }) {
  if (!account?.clinic) return error(403, "A clinic account is required.");
  if (!row || row.clinic !== account.clinic) return error(404, "Referral unavailable.");
  if (expired(row)) return error(410, "Referral expired.");
  if (!signed_pass && !row.accepted_at) return error(409, "Accept the referral first.");
  if (!["view", "export"].includes(access_purpose)) return error(400, "Choose an access purpose.");
  const items = row.items.filter(item => item.id !== "note" || !row.withdrawn);
  if (row.request?.status === "approved") items.push(previousResult);
  addEvent(row, access_purpose, items.map(item => item.id));
  return { items };
}

function manageReferral(row, account, { manage_action: action, request_reason: reason }) {
  const isClinic = !!account?.clinic;
  if (!account || (action === "request" && !isClinic) ||
      (isClinic && !["review", "request"].includes(action))) {
    return error(403, "Action unavailable.");
  }
  if (!row || (isClinic ? row.clinic !== account.clinic : row.patient_id !== account.id)) {
    return error(404, "Referral unavailable.");
  }
  if ((isClinic || action !== "review") && expired(row)) return error(410, "Referral expired.");
  if (isClinic && !row.accepted_at) return error(409, "Accept the referral first.");

  if (action === "withdraw" && !row.withdrawn) {
    if (row.paper_ids.includes("note") || !row.items.some(item => item.id === "note")) {
      return error(409, "There is no online-only note to withdraw.");
    }
    row.withdrawn = true;
    addEvent(row, action, ["note"]);
  }
  if (action === "request") {
    reason = reason?.trim();
    if (!reason || reason.length > 240) return error(400, "A reason is required.");
    if (row.request && row.request.reason !== reason) return error(409, "A request already exists.");
    if (!row.request) {
      row.request = { reason, status: "pending" };
      addEvent(row, action, ["previous-result"]);
    }
  }
  if (["approve", "decline"].includes(action)) {
    const status = action === "approve" ? "approved" : "declined";
    if (!row.request || !["pending", status].includes(row.request.status)) {
      return error(409, "There is no pending request.");
    }
    if (row.request.status === "pending") {
      row.request.status = status;
      addEvent(row, action, ["previous-result"]);
    }
  }

  const access = row.events.filter(event => ["view", "export"].includes(event.kind));
  return { review: {
    printMode: row.print_mode, paperIds: row.paper_ids, withdrawn: row.withdrawn,
    sharedIds: [...new Set(access.flatMap(event => event.itemIds))],
    request: row.request, events: row.events,
    ...(!isClinic && { items: [...row.items, previousResult] })
  } };
}

export async function startMockSupabase() {
  const rows = new Map();
  const tokens = new Map();
  const calls = [];
  let nextToken = 1;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    calls.push({ path: url.pathname, query: url.searchParams, method: request.method, body });
    const send = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (url.pathname.startsWith("/auth/")) {
      if (request.headers.apikey !== mockPublishableKey) return send(401, { message: "Invalid publishable key" });
      if (url.pathname === "/auth/v1/token") {
        const user = accounts.find(account => account.email === body.email);
        if (!user || body.password !== "demo-password") return send(400, { message: "Invalid credentials" });
        const token = "test-token-" + nextToken++;
        tokens.set(token, user);
        return send(200, { access_token: token, expires_in: 3600, user: { id: user.id, email: user.email } });
      }
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      const user = tokens.get(token);
      if (!user) return send(401, { message: "Invalid session" });
      if (url.pathname === "/auth/v1/user") return send(200, { id: user.id, email: user.email });
      if (url.pathname === "/auth/v1/logout") {
        tokens.delete(token);
        return send(200, {});
      }
    }
    if (url.pathname.startsWith("/rest/")) {
      if (request.headers.apikey !== mockSecretKey) return send(401, { message: "Service key required" });
      if (url.pathname === "/rest/v1/referral_accounts") {
        return send(200, accounts.filter(account => "eq." + account.id === url.searchParams.get("user_id"))
          .map(account => ({ clinic: account.clinic })));
      }
      if (url.pathname === "/rest/v1/referral_intake" && request.method === "POST") {
        if (rows.has(body.id)) return send(409, { message: "Duplicate referral" });
        const row = {
          ...body, accepted_at: null, accepted_by: null, withdrawn: false, request: null, events: []
        };
        addEvent(row, "issued", row.paper_ids, row.issued_at);
        rows.set(row.id, row);
        return send(201, [row]);
      }
      if (url.pathname === "/rest/v1/referral_intake" && request.method === "GET") {
        let selected = [...rows.values()];
        for (const field of ["id", "patient_id", "clinic"]) {
          const filter = url.searchParams.get(field);
          if (filter) selected = selected.filter(row => "eq." + row[field] === filter);
        }
        if (url.searchParams.get("accepted_at") === "not.is.null") {
          selected = selected.filter(row => row.accepted_at !== null);
        }
        const columns = url.searchParams.get("select").split(",");
        return send(200, selected.map(row => Object.fromEntries(columns.map(column => [column, row[column]]))));
      }
      if (url.pathname === "/rest/v1/rpc/accept_referral") {
        const row = rows.get(body.referral_id);
        const account = accounts.find(account => account.id === body.staff_user);
        if (!row || !account?.clinic || row.clinic !== account.clinic ||
            (!row.accepted_at && expired(row))) return send(200, []);
        if (!row.accepted_at) {
          row.accepted_at = new Date().toISOString();
          row.accepted_by = account.id;
          addEvent(row, "intake", row.paper_ids, row.accepted_at);
        }
        return send(200, [{ id: row.id, accepted_at: row.accepted_at }]);
      }
      if (url.pathname === "/rest/v1/rpc/referral_details") {
        const account = accounts.find(account => account.id === body.staff_user);
        return send(200, referralDetails(rows.get(body.referral_id), account, body));
      }
      if (url.pathname === "/rest/v1/rpc/manage_referral") {
        const account = accounts.find(account => account.id === body.actor_user);
        return send(200, manageReferral(rows.get(body.referral_id), account, body));
      }
    }
    send(404, { message: "Unimplemented mock route" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: "http://127.0.0.1:" + server.address().port,
    rows,
    calls,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}
