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
      cities: {
        Row: {
          id: string;
          katottg: string | null;
          name: string;
          category: string;
          region: string | null;
          district: string | null;
          community: string | null;
          label: string;
        };
        Insert: {
          id?: string;
          katottg?: string | null;
          name: string;
          category: string;
          region?: string | null;
          district?: string | null;
          community?: string | null;
          label: string;
        };
        Update: {
          id?: string;
          katottg?: string | null;
          name?: string;
          category?: string;
          region?: string | null;
          district?: string | null;
          community?: string | null;
          label?: string;
        };
        Relationships: [];
      };
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
          timezone: string;
          // 0078 — політика черги при затримці дослідження (пише лише адмін).
          queue_delay_policy: QueueDelayPolicy;
          overlap_threshold_min: number;
          max_cascade_patients: number;
          allow_after_hours_shift: boolean;
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
          timezone?: string;
          queue_delay_policy?: QueueDelayPolicy;
          overlap_threshold_min?: number;
          max_cascade_patients?: number;
          allow_after_hours_shift?: boolean;
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
          timezone?: string;
          queue_delay_policy?: QueueDelayPolicy;
          overlap_threshold_min?: number;
          max_cascade_patients?: number;
          allow_after_hours_shift?: boolean;
        };
        Relationships: [];
      };
      /* 0078 — НЕЗМІННИЙ журнал масових рішень при затримці. authenticated має
         лише SELECT: рядок створює SECURITY DEFINER RPC застосування плану. */
      queue_delay_events: {
        Row: {
          id: string;
          clinic_id: string;
          room_id: string;
          source_entry_id: string;
          delay_min: number;
          strategy: "cascade_shift" | "reschedule_conflicts";
          initiated_by: string;
          approved_by: string | null;
          approved_at: string | null;
          plan: Json;
          outcome: Json | null;
          created_at: string;
        };
        Insert: never;   // писати може лише RPC / service_role
        Update: never;   // журнал незмінний
        Relationships: [];
      };
      /* 0078 — журнал ПІДТВЕРДЖЕНИХ винятків графіка (0077): хто, чому, який слот.
         kind лише after_hours | break — закритий день і час до відкриття лишаються
         забороненими (рішення власника). Insert можна, update/delete — ні. */
      schedule_exceptions: {
        Row: {
          id: string;
          clinic_id: string;
          room_id: string;
          entry_id: string | null;
          kind: ScheduleExceptionKind;
          reason: string;
          from_slot: Json | null;
          to_slot: Json;
          confirmed_by: string;
          created_at: string;
        };
        /* Ззовні — ТІЛЬКИ читання (рішення після ревʼю). Рядок пише тригер на
           queue_entries у ТІЙ САМІЙ транзакції, що й бронь/перенос (етап 2):
           інакше бронь і лог — два окремі запити, і журнал може розійтися з фактом. */
        Insert: never;   // пише лише тригер / service_role
        Update: never;   // журнал незмінний
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
          city: string | null;
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
          city?: string | null;
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
          city?: string | null;
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
          duration_min: number | null; // 0117: null = час не задано (UI «—», ручний ввід)
          contrast_allowed: boolean;
          price: number;                   // 0107: базова ціна, грн
          contrast_price: number | null;   // 0107: доплата за контраст; null = дефолт CONTRAST_SURCHARGE
          active: boolean;                 // 0107: м'яке вимкнення позиції
          sort_order: number;              // 0107
          source: string;                  // 0107: 'manual' | 'seed' | 'import'
          updated_at: string;              // 0107
          created_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          name: string;
          modality: Database["public"]["Enums"]["modality"];
          duration_min?: number | null;
          contrast_allowed?: boolean;
          price?: number;
          contrast_price?: number | null;
          active?: boolean;
          sort_order?: number;
          source?: string;
          updated_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          name?: string;
          modality?: Database["public"]["Enums"]["modality"];
          duration_min?: number | null;
          contrast_allowed?: boolean;
          price?: number;
          contrast_price?: number | null;
          active?: boolean;
          sort_order?: number;
          source?: string;
          updated_at?: string;
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
      service_room_overrides: {
        // 0108: переозначення каталогу по кабінету (base services + override).
        Row: {
          clinic_id: string;
          room_id: string;
          service_id: string;
          price: number | null;          // null = базова services.price
          duration_min: number | null;   // null = базова services.duration_min
          contrast_price: number | null; // null = базова services.contrast_price
          active: boolean;               // false = послуга схована в цьому кабінеті
          updated_at: string;
          created_at: string;
        };
        Insert: {
          clinic_id: string;
          room_id: string;
          service_id: string;
          price?: number | null;
          duration_min?: number | null;
          contrast_price?: number | null;
          active?: boolean;
          updated_at?: string;
          created_at?: string;
        };
        Update: {
          clinic_id?: string;
          room_id?: string;
          service_id?: string;
          price?: number | null;
          duration_min?: number | null;
          contrast_price?: number | null;
          active?: boolean;
          updated_at?: string;
          created_at?: string;
        };
        Relationships: [];
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
          clarify_at: string | null;
          note: string | null;
          created_at: string;
          updated_at: string;
          scheduled_date: string | null;
          scheduled_time: string | null;
          duration_min: number;
          buffer_time_min: number;
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
          priority_level: Database["public"]["Enums"]["patient_priority"];
          call_note: string | null;
          radiologist_note: string | null;
          indication: string | null;
          created_by: string | null;
          in_progress_at: string | null;
          studies_original: Json | null;
          referrer_id: string | null;
          reschedule_origin: Json | null;
          studies_changed_by: string | null;
          off_schedule: boolean;
          case_id: string | null;
          case_step: number | null;
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
          clarify_at?: string | null;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
          scheduled_date?: string | null;
          scheduled_time?: string | null;
          duration_min?: number;
          buffer_time_min?: number;
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
          priority_level?: Database["public"]["Enums"]["patient_priority"];
          call_note?: string | null;
          radiologist_note?: string | null;
          indication?: string | null;
          created_by?: string | null;
          in_progress_at?: string | null;
          studies_original?: Json | null;
          referrer_id?: string | null;
          reschedule_origin?: Json | null;
          studies_changed_by?: string | null;
          off_schedule?: boolean;
          case_id?: string | null;
          case_step?: number | null;
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
          clarify_at?: string | null;
          note?: string | null;
          created_at?: string;
          updated_at?: string;
          scheduled_date?: string | null;
          scheduled_time?: string | null;
          duration_min?: number;
          buffer_time_min?: number;
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
          priority_level?: Database["public"]["Enums"]["patient_priority"];
          call_note?: string | null;
          radiologist_note?: string | null;
          indication?: string | null;
          created_by?: string | null;
          in_progress_at?: string | null;
          studies_original?: Json | null;
          referrer_id?: string | null;
          reschedule_origin?: Json | null;
          studies_changed_by?: string | null;
          off_schedule?: boolean;
          case_id?: string | null;
          case_step?: number | null;
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
          },
          {
            foreignKeyName: "queue_entries_case_id_fkey";
            columns: ["case_id"];
            referencedRelation: "patient_cases";
            referencedColumns: ["id"];
          }
        ];
      };
      patient_cases: {
        Row: {
          id: string;
          clinic_id: string;
          referrer_id: string | null;
          created_by: string | null;
          status: Database["public"]["Enums"]["case_status"];
          sequential: boolean;
          note: string | null;
          patient_name: string;
          patient_phone: string | null;
          patient_dob: string | null;
          patient_sex: string | null;
          patient_email: string | null;
          patient_weight: number | null;   // 0106: вага у знімку кейса (M5)
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          referrer_id?: string | null;
          created_by?: string | null;
          status?: Database["public"]["Enums"]["case_status"];
          sequential?: boolean;
          note?: string | null;
          patient_name: string;
          patient_phone?: string | null;
          patient_dob?: string | null;
          patient_sex?: string | null;
          patient_email?: string | null;
          patient_weight?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          referrer_id?: string | null;
          created_by?: string | null;
          status?: Database["public"]["Enums"]["case_status"];
          sequential?: boolean;
          note?: string | null;
          patient_name?: string;
          patient_phone?: string | null;
          patient_dob?: string | null;
          patient_sex?: string | null;
          patient_email?: string | null;
          patient_weight?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "patient_cases_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "patient_cases_referrer_id_fkey";
            columns: ["referrer_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "patient_cases_created_by_fkey";
            columns: ["created_by"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      waitlist_entries: {
        Row: {
          id: string;
          clinic_id: string;
          source_entry_id: string | null;
          scheduled_entry_id: string | null;
          claim_token: string | null;
          room_id: string | null;
          patient_name: string;
          patient_phone: string | null;
          patient_dob: string | null;
          patient_sex: string | null;
          patient_age: number | null;
          patient_weight: number | null;
          patient_email: string | null;
          studies: Json;
          duration_min: number;
          buffer_time_min: number;
          modality: Database["public"]["Enums"]["modality"] | null;
          priority_level: Database["public"]["Enums"]["patient_priority"];
          desired_date_from: string | null;
          desired_date_to: string | null;
          desired_time_from: string | null;
          desired_time_to: string | null;
          status: Database["public"]["Enums"]["waitlist_status"];
          note: string | null;
          referrer_id: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          clinic_id: string;
          source_entry_id?: string | null;
          scheduled_entry_id?: string | null;
          claim_token?: string | null;
          room_id?: string | null;
          patient_name: string;
          patient_phone?: string | null;
          patient_dob?: string | null;
          patient_sex?: string | null;
          patient_age?: number | null;
          patient_weight?: number | null;
          patient_email?: string | null;
          studies?: Json;
          duration_min?: number;
          buffer_time_min?: number;
          modality?: Database["public"]["Enums"]["modality"] | null;
          priority_level?: Database["public"]["Enums"]["patient_priority"];
          desired_date_from?: string | null;
          desired_date_to?: string | null;
          desired_time_from?: string | null;
          desired_time_to?: string | null;
          status?: Database["public"]["Enums"]["waitlist_status"];
          note?: string | null;
          referrer_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          clinic_id?: string;
          source_entry_id?: string | null;
          scheduled_entry_id?: string | null;
          claim_token?: string | null;
          room_id?: string | null;
          patient_name?: string;
          patient_phone?: string | null;
          patient_dob?: string | null;
          patient_sex?: string | null;
          patient_age?: number | null;
          patient_weight?: number | null;
          patient_email?: string | null;
          studies?: Json;
          duration_min?: number;
          buffer_time_min?: number;
          modality?: Database["public"]["Enums"]["modality"] | null;
          priority_level?: Database["public"]["Enums"]["patient_priority"];
          desired_date_from?: string | null;
          desired_date_to?: string | null;
          desired_time_from?: string | null;
          desired_time_to?: string | null;
          status?: Database["public"]["Enums"]["waitlist_status"];
          note?: string | null;
          referrer_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "waitlist_entries_clinic_id_fkey";
            columns: ["clinic_id"];
            referencedRelation: "clinics";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_source_entry_id_fkey";
            columns: ["source_entry_id"];
            referencedRelation: "queue_entries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_scheduled_entry_id_fkey";
            columns: ["scheduled_entry_id"];
            referencedRelation: "queue_entries";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_room_id_fkey";
            columns: ["room_id"];
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_referrer_id_fkey";
            columns: ["referrer_id"];
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "waitlist_entries_created_by_fkey";
            columns: ["created_by"];
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
      referrer_private: {
        Row: {
          referrer_id: string;
          email: string | null;
          updated_at: string;
        };
        Insert: {
          referrer_id: string;
          email?: string | null;
          updated_at?: string;
        };
        Update: {
          referrer_id?: string;
          email?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "referrer_private_referrer_id_fkey";
            columns: ["referrer_id"];
            referencedRelation: "profiles";
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
      audit_log: {
        Row: {
          id: number;
          at: string;
          actor: string | null;
          clinic_id: string | null;
          table_name: string;
          row_id: string | null;
          action: string;
          before: Json | null;
          after: Json | null;
        };
        Insert: {
          at?: string;
          actor?: string | null;
          clinic_id?: string | null;
          table_name: string;
          row_id?: string | null;
          action: string;
          before?: Json | null;
          after?: Json | null;
        };
        Update: {
          at?: string;
          actor?: string | null;
          clinic_id?: string | null;
          table_name?: string;
          row_id?: string | null;
          action?: string;
          before?: Json | null;
          after?: Json | null;
        };
        Relationships: [];
      };
      event_outbox: {
        // next_attempt_at / dead — міграція 0064 (backoff + DLQ).
        Row: {
          id: number;
          created_at: string;
          event_type: string;
          idempotency_key: string;
          payload: Json;
          delivered_at: string | null;
          attempts: number;
          last_error: string | null;
          next_attempt_at: string;
          dead: boolean;
        };
        Insert: {
          created_at?: string;
          event_type: string;
          idempotency_key?: string;
          payload: Json;
          delivered_at?: string | null;
          attempts?: number;
          last_error?: string | null;
          next_attempt_at?: string;
          dead?: boolean;
        };
        Update: {
          created_at?: string;
          event_type?: string;
          idempotency_key?: string;
          payload?: Json;
          delivered_at?: string | null;
          attempts?: number;
          last_error?: string | null;
          next_attempt_at?: string;
          dead?: boolean;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      cancel_case_rpc: {
        Args: { p_case_id: string };
        Returns: number;
      };
      create_case_rpc: {
        Args: { p_case: Json; p_steps: Json };
        Returns: string;
      };
      add_case_step_rpc: {
        Args: { p_case_id: string; p_step: Json };
        Returns: string;
      };
      case_from_entry_rpc: {
        Args: { p_entry_id: string; p_step: Json };
        Returns: string;
      };
      schedule_from_waitlist_rpc: {
        Args: { p_waitlist_id: string; p_booking: Json };
        Returns: string;
      };
      waitlist_candidates_for_slot: {
        Args: { p_room: string | null; p_date: string; p_time_min: number };
        Returns: Database["public"]["Tables"]["waitlist_entries"]["Row"][];
      };
      waitlist_counts: {
        Args: { p_modality?: string | null };
        Returns: { waiting: number; cito: number; urgent: number; scheduled: number; removed: number }[];
      };
      // 0115: фінальний upsert імпорту прайса (SECURITY DEFINER, admin-гейт усередині).
      services_import_rpc: {
        Args: { p_rows: Json; p_room_id?: string | null };
        Returns: Json;
      };
      set_waitlist_status_rpc: {
        Args: { p_id: string; p_status: Database["public"]["Enums"]["waitlist_status"] };
        Returns: string;
      };
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
        Args: { p_room: string; p_date: string; p_exclude?: string };
        /* status/patient_name/studies — лише для admin/radiologist цього центру (0062),
           для реєстратора та направника NULL (знеособлена зайнятість).
           0074: рядки вибираються за ФАКТИЧНИМ вікном зайнятості (in_progress —
           від in_progress_at), тож сюди потрапляють і «хвости» з попередньої доби.
           Вікно ОБРІЗАНЕ по запитаній добі: *_min — хвилини від 00:00 (0..1440),
           а scheduled_time/duration_min/buffer_time_min — те саме вікно у старому
           вигляді (duration_min може бути 0, якщо в добу зайшов лише буфер). */
        Returns: {
          scheduled_time: string;
          duration_min: number;
          buffer_time_min: number;
          start_min: number;
          end_study_min: number;
          end_min: number;
          status: string | null;
          patient_name: string | null;
          studies: Json | null;
        }[];
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
      search_cities: {
        Args: { q: string };
        Returns: {
          id: string;
          name: string;
          region: string | null;
          district: string | null;
          category: string;
          label: string;
        }[];
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
      ceo_list_for_clinic: {
        Args: { p_clinic: string };
        Returns: {
          id: string;
          login: string | null;
          full_name: string | null;
          email: string | null;
          phone: string | null;
          note: string | null;
          password_set: boolean;
          invite_token: string | null;
          role: string;
        }[];
      };
      emergency_stop_rpc: {
        Args: { p_room_ids: string[]; p_date: string; p_note?: string | null };
        Returns: {
          stopped: number;
          affected: number;
          stopped_rooms: string[];
          patients: Json;
        }[];
      };
      /* 0072: резолв логін→email на вході. Лише service_role (для клієнтів це був би
         інструмент енумерації акаунтів). Бере індекс profiles_login_lower_idx. */
      resolve_login_email: {
        Args: { p_login: string };
        Returns: string | null;
      };
      /* 0071: агрегати CEO-дашборда рахує БД (раніше в браузер їхали всі рядки
         за період по всіх центрах — разом із ПІБ і studies). */
      ceo_kpi_totals: {
        Args: { p_from: string; p_to: string; p_clinics?: string[] | null };
        Returns: { scheduled_date: string; status: string; cnt: number; booked_min: number }[];
      };
      ceo_kpi_rooms: {
        Args: { p_from: string; p_to: string; p_clinics?: string[] | null };
        Returns: { room_id: string; booked_min: number }[];
      };
      ceo_kpi_studies: {
        Args: { p_from: string; p_to: string; p_clinics?: string[] | null };
        Returns: {
          status: string;
          study_type: string;
          region: string;
          contrast: boolean;
          cnt: number;        // позицій (дохід)
          first_cnt: number;  // записів, де це дослідження перше (топ-5)
          priced_sum: number;
          unpriced: number;
        }[];
      };
      /* 0070: колонки станів (status, call_status, in_progress_at, clarify_at,
         reschedule_origin) ВІДКЛИКАНІ в authenticated — писати їх може лише ці RPC
         (SECURITY DEFINER), де живуть авторизація, CAS і правила переходів. */
      queue_set_status_rpc: {
        Args: {
          p_id: string;
          p_status: QueueStatus;
          p_expected?: QueueStatus;
          p_allowed?: QueueStatus[];
          p_note?: string | null;
          p_set_note?: boolean;   // true → note перезаписується (у т.ч. null = стерти)
        };
        Returns: { updated: boolean; current_status: QueueStatus }[];
      };
      queue_set_call_rpc: {
        Args: { p_id: string; p_call: CallStatus; p_allowed?: QueueStatus[] };
        Returns: { updated: boolean; current_status: QueueStatus; current_call: CallStatus }[];
      };
      queue_confirm_calls_rpc: {
        Args: { p_ids: string[] };
        Returns: number;
      };
      queue_reschedule_rpc: {
        Args: {
          p_id: string;
          p_room_id: string;
          p_date: string;
          p_time: string;
          p_duration: number;
          p_buffer: number;
          p_call?: CallStatus | null;
          p_reason?: string | null;
          // 0077: робота поза графіком за підтвердженням. Прапорець ставиться
          // всередині RPC — окремим UPDATE «після» його б відхилив тригер перерви.
          p_off_schedule?: boolean;
        };
        Returns: { updated: boolean; current_status: QueueStatus }[];
      };
      // 0066: створення/редагування простою однією транзакцією (інцидент +
      // переведення пацієнта «у кабінеті» в not_held). Статус planned/active
      // рахує БД у настінному часі клініки.
      submit_incident_rpc: {
        Args: {
          p_room_id: string;
          p_reason: string;
          p_id?: string;
          p_reason_label?: string;
          p_note?: string;
          p_started_at?: string;
          p_blocked_until?: string;
          p_auto_unblock?: boolean;
        };
        Returns: {
          id: string;
          status: string;
          not_held: number;
        }[];
      };
      /* 0080 + 0081: ЄДИНИЙ шлях, яким у системі зʼявляється статус
         'needs_reschedule', і єдине місце, де записи кабінету рухаються масово.
         Застосовує ЛИШЕ адмін свого центру (гейт усередині RPC — вона видана
         authenticated). Все-або-нічого: пост-умова moved + flagged = розмір плану,
         інакше raise і відкат.

         p_plan  — [{id, kind: 'shift'|'no_fit'|'conflict', from:"HH:MM",
                     to:"HH:MM"|null, offSchedule?: boolean,
                     offScheduleKind?: 'after_hours'|'break',
                     reason?: 'on_time'|'cascade'|'no_slot_today'|'overlap_with_actual'}]
                   ⚠️ 'keep' НЕ приймається (0081): застосовувати там нічого, і в
                   пост-умові він чекав би UPDATE, якого не буде. Фільтрує Server Action.
         p_expected — знімок [{id, status}], який бачив адмін. ЗОБОВʼЯЗАНИЙ покривати
                   весь p_plan (у 0080 порожній знімок мовчки вимикав stale-гард).

         Повертає applied=false + stale_ids, якщо стан розійшовся зі знімком або
         запис уже не в ('scheduled','waiting') — тоді в БД НІЧОГО не змінено. */
      queue_apply_delay_plan_rpc: {
        Args: {
          p_room: string;
          p_source: string;
          p_delay_min: number;
          p_strategy: "cascade_shift" | "reschedule_conflicts";
          p_plan: Json;
          p_expected: Json;
          p_reason?: string | null;
        };
        Returns: {
          applied: boolean;
          moved: number;
          flagged: number;
          stale_ids: string[];
          event_id: string | null;
        }[];
      };
      outbox_mark_failed: {
        Args: { p_id: number; p_error: string };
        Returns: undefined;
      };
      sink_overdue_scheduled: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      sink_overdue_scheduled_all: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
    };
    Enums: {
      user_role: "admin" | "radiologist" | "registrar" | "referrer" | "ceo";
      ceo_access_status: "active" | "revoked";
      case_status: "open" | "completed" | "cancelled";
      modality: "MRI" | "CT" | "OTHER" | "US" | "XRAY" | "MAMMO";
      queue_status:
        | "scheduled"
        | "waiting"
        | "in_progress"
        | "done"
        | "no_show"
        | "cancelled"
        | "not_held"
        /* 0078: слот втрачено через ОПЕРАЦІЙНУ затримку кабінету — потрібен перенос.
           Це НЕ 'cancelled' (рішення пацієнта/центру зняти запис): пацієнт нікуди
           не дівся, на нього чекає реєстратура. Змішування зіпсувало б і колл-лист,
           і KPI. Тригери/переходи/RPC під цей статус — міграція 0079. */
        | "needs_reschedule";
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
      patient_priority: "cito" | "urgent" | "planned";
      waitlist_status: "waiting" | "scheduled" | "cancelled" | "expired";
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

/* 0078 — політика центру при затримці дослідження.
   manual               — показати обидва плани, вирішує адмін (за замовчуванням);
   cascade_shift        — зсунути наступні записи кабінету (кожен — у ПЕРШИЙ слот,
                          куди він реально вміщується; не однакова дельта);
   reschedule_conflicts — не рухати чергу, конфліктних → needs_reschedule.
   Масове застосування ЗАВЖДИ потребує підтвердження адміна — навіть при авто-політиці. */
export type QueueDelayPolicy = "manual" | "cascade_shift" | "reschedule_conflicts";

/** Тип підтвердженого винятку графіка (0078). Закритий день і час до відкриття — НЕ виняток. */
export type ScheduleExceptionKind = "after_hours" | "break";

export type QueueDelayEvent = Tables<"queue_delay_events">;
export type ScheduleException = Tables<"schedule_exceptions">;
export type WaitlistEntry = Tables<"waitlist_entries">;
export type WaitlistStatus = Enums<"waitlist_status">;
export type CallStatus = Enums<"call_status">;
export type Modality = Enums<"modality">;
export type CaseStatus = Enums<"case_status">;
export type PatientCase = Tables<"patient_cases">;
export type UserRole = Enums<"user_role">;
