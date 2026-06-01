export interface Env {
  DB: D1Database;
  PROSPECT_QUEUE: Queue<ProspectParams>;
  PROSPECT_WORKFLOW: Workflow;
  CLAUDE_API: string;
  GOOGLE_PLACES_KEY: string;
  AUTO_RESEND_KEY: string;
}

export interface Prospect {
  id?: number;
  place_id: string;
  name: string;
  address: string;
  phone: string;
  category: string;
  email: string | null;
  status: 'nuevo' | 'contactado' | 'sin_email' | 'cerrado' | 'error';
  email_subject?: string | null;
  email_body?: string | null;
  error_msg?: string | null;
  email_sent_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ProspectParams {
  place_id: string;
  name: string;
  address: string;
  phone: string;
  category: string;
  email: string | null;
}
