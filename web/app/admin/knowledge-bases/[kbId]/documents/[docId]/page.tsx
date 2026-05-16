import { redirect } from "next/navigation";

export default async function DocumentDetailPage({
  params
}: {
  params: Promise<{ kbId: string; docId: string }>;
}) {
  const { kbId, docId } = await params;
  redirect(`/admin/knowledge/${kbId}/docs/${docId}`);
}
