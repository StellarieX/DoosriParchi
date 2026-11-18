import { handleApi } from "../backend.mjs";

export default async function handler(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const route = typeof req.query?.route === "string" ? req.query.route : null;
  const apiPath = pathname === "/api/[route]" && route ? "/api/" + route : pathname;
  await handleApi(req, res, apiPath === "/api/healthz" ? "/healthz" : apiPath);
}
