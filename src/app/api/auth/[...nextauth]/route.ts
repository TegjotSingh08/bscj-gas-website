import { handlers } from "@/auth";

/**
 * Auth.js sign-in and sign-out endpoints.
 *
 * The only new public route in Phase 1. It exposes no customer data: it
 * accepts an email and a password and answers whether they are an
 * administrator's. Rate limiting sits in front of it in `middleware.ts`.
 */
export const { GET, POST } = handlers;
