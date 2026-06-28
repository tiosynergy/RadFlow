// Supabase schema types for RadFlow.
//
// Reconstructed by hand from supabase/migrations/0001-0039 (source of truth
// for the schema). Replace with auto-generation as soon as possible:
//
//   supabase gen types typescript --linked --schema public > supabase/types.ts
//
// and wire that step into CI AFTER every new migration (otherwise the types
// drift from the schema). Until then, maintain this file by hand on schema change.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      clinics: {
        Row: {
          id: string;
          name: string;
          created_at: string;
          city: string | null;
          address: string | null;
          phones: Json;
          emails: Json;
          configured_at: string | null;
        };
        Insert: {
          id?: string;
          name: string;
          created_at?: string;
          city?: string | null;
          address?: string | null;
          phones?: Json;
          emails?: Json;
          configured_at?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          created_at?: string;
          city?: string | null;
          address?: string | null;
          phones?: Json;
          emails?: Json;
          configured_at?: string | null;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          clinic_id: string | null;
          full_name: string | null;
          email: string | null;
          phone: string | null;
          role: Database["public"]["Enums"]["user_role"];
          created_at: string;
          approved: boolean;
          login: string | null;
          note: string | null;
          workplace: string | null;
          password_set: boolean;
          invite_token: string | null;
        };
        Insert: {
          id: string;
          clinic_id?: string | null;
          full_name?: string | null;
          email?: string | null;
          phone?: string | null;
          role?: Database["public"]["Enums"]["user_role"];
          created_at?: string;
          approved?: boolean;
          login?: string | null;
          note?: string | null;
          workplace?: string | null;
          password_set?: boolean;
          invite_token?: string | null;
        };
        Update: {
          id?: string;
          clinic_id?: string | null;
          full_name?: string | null;
          email?: string | null;
          phone?: string | null;
          role?: Database["public"]["Enums"]["user_role"];
          created_at?: string;
          approved?: boolean;
          login?: string | null;
          note?: string | null;
          workplace?: string | null;
          password_set?: boolean;
          invite_token?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      rooms: {
        Row: {
          id: string;
          clinic_id: string;
          name: string;
          modality: Database["public"]["Enums"]["modality"];
          apparatus_model: string | null;
          created_at: string;
          schedule: Json;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          name: string;
          modality: Database["public"]["Enums"]["modality"];
          apparatus_model?: string | null;
          created_at?: string;
          schedule?: Json;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          name?: string;
          modality?: Database["public"]["Enums"]["modality"];
          apparatus_model?: string | null;
          created_at?: string;
          schedule?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "rooms_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      services: {
        Row: {
          id: string;
          clinic_id: string;
          name: string;
          modality: Database["public"]["Enums"]["modality"];
          duration_min: number;
          contrast_allowed: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          name: string;
          modality: Database["public"]["Enums"]["modality"];
          duration_min?: number;
          contrast_allowed?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          name?: string;
          modality?: Database["public"]["Enums"]["modality"];
          duration_min?: number;
          contrast_allowed?: boolean;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "services_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      queue_entries: {
        Row: {
          id: string;
          clinic_id: string;
          room_id: string | null;
          patient_name: string;
          patient_phone: string | null;
          status: Database["public"]["Enums"]["queue_status"];
          call_status: Database["public"]["Enums"]["call_status"];
          priority: number;
          scheduled_at: string | null;
          note: string | null;
          created_at: string;
          updated_at: string;
          scheduled_date: string | null;
          scheduled_time: string | null;
          duration_min: number;
          studies: Json;
          patient_dob: string | null;
          patient_sex: string | null;
          patient_age: number | null;
          patient_weight: number | null;
          patient_email: string | null;
          contraindications: boolean;
          has_contrast: boolean;
          doctor: string | null;
          cito: boolean;
          call_note: string | null;
          radiologist_note: string | null;
          indication: string | null;
          created_by: string | null;
          in_progress_at: string | null;
          studies_original: Json | null;
          referrer_id: string | null;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          room_id?: string | null;
          patient_name: string;
          patient_phone?: string | null;
          status?: Database["public"]["Enums"]["queue_status"];
          call_status?: Database["public"]["Enums"]["call_status"];
          priority?: number;
          scheduled_at?: string | null;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
          scheduled_date?: string | null;
          scheduled_time?: string | null;
          duration_min?: number;
          studies?: Json;
          patient_dob?: string | null;
          patient_sex?: string | null;
          patient_age?: number | null;
          patient_weight?: number | null;
          patient_email?: string | null;
          contraindications?: boolean;
          has_contrast?: boolean;
          doctor?: string | null;
          cito?: boolean;
          call_note?: string | null;
          radiologist_note?: string | null;
          indication?: string | null;
          created_by?: string | null;
          in_progress_at?: string | null;
          studies_original?: Json | null;
          referrer_id?: string | null;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          room_id?: string | null;
          patient_name?: string;
          patient_phone?: string | null;
          status?: Database["public"]["Enums"]["queue_status"];
          call_status?: Database["public"]["Enums"]["call_status"];
          priority?: number;
          scheduled_at?: string | null;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
          scheduled_date?: string | null;
          scheduled_time?: string | null;
          duration_min?: number;
          studies?: Json;
          patient_dob?: string | null;
          patient_sex?: string | null;
          patient_age?: number | null;
          patient_weight?: number | null;
          patient_email?: string | null;
          contraindications?: boolean;
          has_contrast?: boolean;
          doctor?: string | null;
          cito?: boolean;
          call_note?: string | null;
          radiologist_note?: string | null;
          indication?: string | null;
          created_by?: string | null;
          in_progress_at?: string | null;
          studies_original?: Json | null;
          referrer_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "queue_entries_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "queue_entries_room_id_fkey";
            columns: ["room_id"];
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "queue_entries_created_by_fkey";
            columns: ["created_by"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "queue_entries_referrer_id_fkey";
            columns: ["referrer_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      incidents: {
        Row: {
          id: string;
          clinic_id: string;
          room_id: string;
          reason: string;
          reason_label: string | null;
          note: string | null;
          started_at: string;
          blocked_until: string | null;
          status: Database["public"]["Enums"]["incident_status"];
          created_at: string;
          resolved_at: string | null;
          auto_unblock: boolean;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          room_id: string;
          reason?: string;
          reason_label?: string | null;
          note?: string | null;
          started_at?: string;
          blocked_until?: string | null;
          status?: Database["public"]["Enums"]["incident_status"];
          created_at?: string;
          resolved_at?: string | null;
          auto_unblock?: boolean;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          room_id?: string;
          reason?: string;
          reason_label?: string | null;
          note?: string | null;
          started_at?: string;
          blocked_until?: string | null;
          status?: Database["public"]["Enums"]["incident_status"];
          created_at?: string;
          resolved_at?: string | null;
          auto_unblock?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "incidents_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_room_id_fkey";
            columns: ["room_id"];
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          }
        ];
      };
      schedule_overrides: {
        Row: {
          id: string;
          clinic_id: string;
          override_date: string;
          all_closed: boolean;
          label: string | null;
          rooms: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          override_date: string;
          all_closed?: boolean;
          label?: string | null;
          rooms?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          override_date?: string;
          all_closed?: boolean;
          label?: string | null;
          rooms?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "schedule_overrides_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      doctors: {
        Row: {
          id: string;
          clinic_id: string;
          name: string;
          spec: string | null;
          clinic_name: string | null;
          phone: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          name: string;
          spec?: string | null;
          clinic_name?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          name?: string;
          spec?: string | null;
          clinic_name?: string | null;
          phone?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "doctors_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      clinic_invites: {
        Row: {
          id: string;
          clinic_id: string;
          email: string;
          role: Database["public"]["Enums"]["user_role"];
          room_ids: string[];
          created_at: string;
          accepted_at: string | null;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          email: string;
          role?: Database["public"]["Enums"]["user_role"];
          room_ids?: string[];
          created_at?: string;
          accepted_at?: string | null;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          email?: string;
          role?: Database["public"]["Enums"]["user_role"];
          room_ids?: string[];
          created_at?: string;
          accepted_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "clinic_invites_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      radiologist_rooms: {
        Row: {
          id: string;
          clinic_id: string;
          profile_id: string;
          room_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          profile_id: string;
          room_id: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          profile_id?: string;
          room_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "radiologist_rooms_profile_id_fkey";
            columns: ["profile_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "radiologist_rooms_room_id_fkey";
            columns: ["room_id"];
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          }
        ];
      };
      ceo_access: {
        Row: {
          id: string;
          ceo_id: string;
          clinic_id: string;
          status: Database["public"]["Enums"]["ceo_access_status"];
          granted_by: string | null;
          note: string | null;
          created_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          ceo_id: string;
          clinic_id: string;
          status?: Database["public"]["Enums"]["ceo_access_status"];
          granted_by?: string | null;
          note?: string | null;
          created_at?: string;
          revoked_at?: string | null;
        };
        Update: {
          id?: string;
          ceo_id?: string;
          clinic_id?: string;
          status?: Database["public"]["Enums"]["ceo_access_status"];
          granted_by?: string | null;
          note?: string | null;
          created_at?: string;
          revoked_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ceo_access_ceo_id_fkey";
            columns: ["ceo_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "ceo_access_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      referral_access: {
        Row: {
          id: string;
          referrer_id: string;
          clinic_id: string;
          status: Database["public"]["Enums"]["referral_access_status"];
          policy: Database["public"]["Enums"]["referral_policy"];
          initiated_by: string | null;
          note: string | null;
          created_at: string;
          decided_at: string | null;
          modalities: Database["public"]["Enums"]["modality"][] | null;
          room_ids: string[] | null;
        };
        Insert: {
          id?: string;
          referrer_id: string;
          clinic_id: string;
          status: Database["public"]["Enums"]["referral_access_status"];
          policy?: Database["public"]["Enums"]["referral_policy"];
          initiated_by?: string | null;
          note?: string | null;
          created_at?: string;
          decided_at?: string | null;
          modalities?: Database["public"]["Enums"]["modality"][] | null;
          room_ids?: string[] | null;
        };
        Update: {
          id?: string;
          referrer_id?: string;
          clinic_id?: string;
          status?: Database["public"]["Enums"]["referral_access_status"];
          policy?: Database["public"]["Enums"]["referral_policy"];
          initiated_by?: string | null;
          note?: string | null;
          created_at?: string;
          decided_at?: string | null;
          modalities?: Database["public"]["Enums"]["modality"][] | null;
          room_ids?: string[] | null;
        };
        Relationships: [
          {
            foreignKeyName: "referral_access_referrer_id_fkey";
            columns: ["referrer_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_access_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          }
        ];
      };
      rate_limits: {
        Row: {
          key: string;
          window_start: string;
          count: number;
        };
        Insert: {
          key: string;
          window_start?: string;
          count?: number;
        };
        Update: {
          key?: string;
          window_start?: string;
          count?: number;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      auth_clinic_id: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      auth_is_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      auth_is_referrer: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      auth_can_refer: {
        Args: { c: string };
        Returns: boolean;
      };
      auth_ceo_clinics: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      auth_is_ceo_of: {
        Args: { c: string };
        Returns: boolean;
      };
      auth_referrer_clinics: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      auth_referrer_can_book_room: {
        Args: { p_room: string };
        Returns: boolean;
      };
      delete_clinic_member: {
        Args: { target: string };
        Returns: undefined;
      };
      room_busy_slots: {
        Args: { p_room: string; p_date: string };
        Returns: { scheduled_time: string; duration_min: number }[];
      };
      search_clinics: {
        Args: { q: string };
        Returns: {
          id: string;
          name: string;
          city: string | null;
          modalities: string[];
        }[];
      };
      referral_center_card: {
        Args: { p_access_id: string };
        Returns: Json;
      };
      search_referrers: {
        Args: { q: string };
        Returns: { id: string; login: string | null; full_name: string | null }[];
      };
      // EXECUTE revoked from anon/authenticated (0032/0033) - called ONLY by the
      // server admin client (service_role bypasses grants). Still need the types,
      // otherwise the typed .rpc() rejects them.
      rl_check: {
        Args: { p_key: string; p_max: number; p_window_seconds: number };
        Returns: boolean;
      };
      email_for_login: {
        Args: { p_login: string };
        Returns: string;
      };
    };
    Enums: {
      user_role: "admin" | "radiologist" | "registrar" | "referrer" | "ceo";
      ceo_access_status: "active" | "revoked";
      modality: "MRI" | "CT" | "OTHER";
      queue_status:
        | "scheduled"
        | "waiting"
        | "in_progress"
        | "done"
        | "no_show"
        | "cancelled"
        | "not_held";
      call_status:
        | "not_called"
        | "to_recall"
        | "no_answer"
        | "confirmed"
        | "declined";
      referral_access_status:
        | "pending_clinic"
        | "pending_referrer"
        | "active"
        | "revoked"
        | "declined";
      referral_policy: "direct" | "confirm";
      // incidents.status is a text column with a CHECK constraint (not a PG enum),
      // but the values are fixed; typed as a union for strictness.
      incident_status: "active" | "planned" | "resolved";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

// --- Convenience aliases (as in supabase gen types) ---
type PublicSchema = Database["public"];

export type Tables<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> =
  PublicSchema["Tables"][T]["Update"];
export type Enums<T extends keyof PublicSchema["Enums"]> =
  PublicSchema["Enums"][T];

// Common domain aliases for the app.
export type QueueEntry = Tables<"queue_entries">;
export type Incident = Tables<"incidents">;
export type Room = Tables<"rooms">;
export type Profile = Tables<"profiles">;
export type ScheduleOverride = Tables<"schedule_overrides">;
export type ReferralAccess = Tables<"referral_access">;
export type QueueStatus = Enums<"queue_status">;
export type CallStatus = Enums<"call_status">;
export type Modality = Enums<"modality">;
export type UserRole = Enums<"user_role">;
