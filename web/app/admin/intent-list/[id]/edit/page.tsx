import { redirect } from "next/navigation";

export default async function IntentEditPage() {
  redirect("/admin/intent-list");
}
