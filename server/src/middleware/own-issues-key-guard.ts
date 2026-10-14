import type { RequestHandler } from "express";

/**
 * The routes an own-issues key may reach: who it is, and an issue's own record, comments and documents, by id. Every
 * other route answers 403 before it runs, so a route that checks only company access (goals, projects, labels and the
 * rest) never sees such a key; within these, `authorizationService.decide` keeps it to its agent's own issues.
 */
const ALLOWED: ReadonlyArray<readonly [string, RegExp]> = [
  ["GET", /^\/agents\/me\/?$/],
  ["GET", /^\/issues\/[^/]+\/?$/],
  ["PATCH", /^\/issues\/[^/]+\/?$/],
  ["GET", /^\/issues\/[^/]+\/comments\/?$/],
  ["POST", /^\/issues\/[^/]+\/comments\/?$/],
  ["GET", /^\/issues\/[^/]+\/documents(?:\/[^/]+)?\/?$/],
  ["PUT", /^\/issues\/[^/]+\/documents\/[^/]+\/?$/],
];

export function ownIssuesKeyGuard(): RequestHandler {
  return (req, res, next) => {
    if (req.actor?.type !== "agent" || req.actor.keyScope?.kind !== "own_issues") {
      next();
      return;
    }
    if (ALLOWED.some(([method, path]) => req.method === method && path.test(req.path))) {
      next();
      return;
    }
    res.status(403).json({ error: "An own-issues key reaches only its agent's own issues" });
  };
}
