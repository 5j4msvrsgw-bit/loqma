import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceKey) return json({ error: "إعدادات الخدمة غير مكتملة على الخادم." }, 500);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "يلزم تسجيل الدخول." }, 401);

  const adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await adminClient.auth.getUser(token);
  if (authError || !authData.user) return json({ error: "جلسة الدخول غير صالحة." }, 401);

  const callerId = authData.user.id;
  const { data: caller, error: roleError } = await adminClient
    .from("staff_members").select("role,is_active").eq("user_id", callerId).maybeSingle();
  if (roleError || caller?.role !== "admin" || caller.is_active !== true) {
    return json({ error: "غير مصرح: هذه الخدمة للمدير فقط." }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "بيانات الطلب غير صحيحة." }, 400); }

  if (body.action === "create_driver") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();
    const phone = String(body.phone || "").trim().replace(/[\s-]/g, "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "اكتب بريدًا إلكترونيًا صحيحًا." }, 400);
    if (password.length < 8) return json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل." }, 400);
    if (!fullName) return json({ error: "اكتب اسم المندوب." }, 400);
    if (phone && !/^01[0-9]{9}$/.test(phone)) return json({ error: "رقم الهاتف يجب أن يكون 11 رقمًا ويبدأ بـ 01." }, 400);

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName, employee_type: "driver" },
    });
    if (createError || !created.user) return json({ error: createError?.message || "تعذر إنشاء حساب الموظف." }, 400);

    const driverId = created.user.id;
    const { error: profileError } = await adminClient.from("profiles").upsert({
      user_id: driverId, full_name: fullName, phone: phone || null, updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (profileError) {
      await adminClient.auth.admin.deleteUser(driverId);
      return json({ error: "تعذر حفظ بيانات المندوب: " + profileError.message }, 500);
    }

    const { error: staffError } = await adminClient.from("staff_members").insert({
      user_id: driverId, role: "driver", is_active: true, created_by: callerId,
    });
    if (staffError) {
      await adminClient.auth.admin.deleteUser(driverId);
      return json({ error: "تعذر تفعيل صلاحية المندوب: " + staffError.message }, 500);
    }
    return json({ success: true, driver: { user_id: driverId, full_name: fullName, phone, email, is_active: true } }, 201);
  }

  if (body.action === "set_driver_active") {
    const driverId = String(body.user_id || "");
    const active = body.is_active;
    if (!driverId || typeof active !== "boolean") return json({ error: "بيانات تعديل الحساب غير مكتملة." }, 400);
    const { data: driver, error: driverError } = await adminClient
      .from("staff_members").select("user_id,role").eq("user_id", driverId).maybeSingle();
    if (driverError || !driver || driver.role !== "driver") return json({ error: "حساب المندوب غير موجود." }, 404);
    const { error: updateError } = await adminClient.from("staff_members")
      .update({ is_active: active, updated_at: new Date().toISOString() }).eq("user_id", driverId);
    if (updateError) return json({ error: updateError.message }, 500);
    return json({ success: true, user_id: driverId, is_active: active });
  }
  return json({ error: "العملية المطلوبة غير معروفة." }, 400);
});