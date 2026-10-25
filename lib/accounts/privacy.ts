// What an account keeps, said in the account menu and at sign-in (Clerk's sign-in screen and the test form).
// Short, and the same everywhere.

/** At sign-in: what is kept, and by whom. */
export const PRIVACY_SIGN_IN = "Your account keeps only your answers: the question, your choice, right or wrong, your confidence and the time. Clerk keeps your email to sign you in.";

/** In the account menu: the same, and how to delete each. */
export const PRIVACY_MENU =
  "Your account keeps only your answers (the question, your choice, right or wrong, your confidence, the time); Delete my data removes them. Clerk keeps your email to sign you in; delete it under Manage sign-in.";

/** Clerk sets these on this site once someone has signed in here; without one, Clerk isn't loaded until "Sign in to save". */
export function hasClerkSession(cookie: string): boolean {
  return cookie.split(/;\s*/).some((c) => {
    const [name, value = ""] = c.split("=");
    return (name === "__session" && value !== "") || (name.startsWith("__client_uat") && value !== "" && value !== "0");
  });
}
