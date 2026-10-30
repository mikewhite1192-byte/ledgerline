import { redirect } from "next/navigation";
import { HOW_PAY_WORKS } from "@/components/app/signed-in-page";

// Help has one page so far; the bare /help lands on it instead of a not-found page.
export default function HelpIndex(): never {
  redirect(HOW_PAY_WORKS.href);
}
