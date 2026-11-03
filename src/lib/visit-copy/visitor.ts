// The visitor's login email inside a visit's own copy of a demo carrier (flags.visitCopies,
// ./build.ts writes it). Never a real address: the .invalid name can never be a Cognito login, so
// only a copy's visitor has it. The shell uses it to show the visit's banner and to say "a demo
// visitor" instead of the address. Display only: no check of who may do what reads it.
export const VISIT_EMAIL = "visitor@ledgerline.invalid";

export function isVisitor(member: { email: string }): boolean {
  return member.email === VISIT_EMAIL;
}
