import type { ActionError } from "@/lib/problem";

export function ErrorBox({ error }: { error: ActionError | null }) {
  if (error === null) return null;
  return (
    <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p>
        <span className="font-mono text-xs">{error.code}</span> {error.message}
      </p>
      {error.issues.length > 0 && (
        <ul className="mt-2 list-disc pl-5">
          {error.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      {error.requestId !== null && <p className="mt-2 text-xs text-red-600">Request id: {error.requestId}</p>}
    </div>
  );
}
