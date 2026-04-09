
const config = window.DEN_SUPABASE_CONFIG || {};
const authView = document.getElementById("authView");
const dashboardView = document.getElementById("dashboardView");
const setupNotice = document.getElementById("setupNotice");
const authTemplate = document.getElementById("authTemplate");

let supabaseClient = null;
let currentSession = null;
let currentProfile = null;
let realtimeChannel = null;

const gym = config.gym || {
  name: "DEN Fitness",
  address: "Shop Number 2, New Kailas Niwas 2, Near 90 Feet Rd, Netaji Nagar, Ashok Nagar, Saki Naka, Mumbai, Maharashtra 400072",
  lat: 19.0937,
  lng: 72.8866,
  radiusMeters: 200,
};

boot();

async function boot() {
  renderAuth();

  if (!isConfigured()) {
    renderSetupNotice();
    return;
  }

  supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  bindAuthForm();

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    renderAuthMessage(error.message, "error");
    return;
  }

  if (data.session) {
    currentSession = data.session;
    await initializeUser();
  }

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    currentSession = session;

    if (event === "SIGNED_OUT" || !session) {
      teardownRealtime();
      currentProfile = null;
      renderAuth();
      bindAuthForm();
      return;
    }

    await initializeUser();
  });
}

function isConfigured() {
  return Boolean(
    config.supabaseUrl &&
    config.supabaseAnonKey &&
    !config.supabaseUrl.includes("YOUR_PROJECT_ID") &&
    !config.supabaseAnonKey.includes("YOUR_SUPABASE_ANON_KEY"),
  );
}

function renderSetupNotice() {
  setupNotice.classList.remove("hidden");
  setupNotice.innerHTML = `
    <p class="section-label">Setup Required</p>
    <h3>Supabase connection missing</h3>
    <p class="muted">Update <code>js/config.js</code> with your Supabase project URL and anon key, then reload the app.</p>
  `;
}

function renderAuth() {
  authView.classList.add("active");
  dashboardView.classList.remove("active");
  authView.innerHTML = "";
  authView.appendChild(authTemplate.content.cloneNode(true));
}

function bindAuthForm() {
  const form = document.getElementById("loginForm");
  if (!form || !supabaseClient) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("emailInput").value.trim();
    const password = document.getElementById("passwordInput").value.trim();

    renderAuthMessage("Signing in...", "success");

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      renderAuthMessage(error.message, "error");
      return;
    }

    renderAuthMessage("Login successful.", "success");
  });
}

function renderAuthMessage(message, type) {
  const target = document.getElementById("authMessage");
  if (!target) return;
  target.textContent = message;
  target.className = `message ${type}`;
}

async function initializeUser() {
  const profile = await fetchCurrentProfile();
  if (!profile) {
    dashboardView.classList.remove("active");
    authView.classList.add("active");
    renderAuthMessage("Profile not found. Run SQL setup and ensure this user exists in profiles.", "error");
    return;
  }

  currentProfile = profile;
  subscribeRealtime();
  await renderDashboard();
}

async function fetchCurrentProfile() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, email, full_name, phone, role")
    .eq("id", currentSession.user.id)
    .single();

  if (error) {
    console.error(error);
    return null;
  }

  return data;
}

function subscribeRealtime() {
  teardownRealtime();

  realtimeChannel = supabaseClient
    .channel("den-fitness-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "members" }, handleRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, handleRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, handleRealtime)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, handleRealtime)
    .subscribe();
}

function teardownRealtime() {
  if (realtimeChannel && supabaseClient) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

async function handleRealtime() {
  if (currentSession && currentProfile) {
    await renderDashboard();
  }
}

async function renderDashboard() {
  authView.classList.remove("active");
  dashboardView.classList.add("active");

  try {
    if (currentProfile.role === "owner") {
      await renderOwnerDashboard();
      return;
    }

    if (currentProfile.role === "trainer") {
      await renderTrainerDashboard();
      return;
    }

    await renderMemberDashboard();
  } catch (error) {
    console.error(error);
    dashboardView.innerHTML = `<div class="panel-card auth-card"><h2>Data load failed</h2><p class="message error">${error.message}</p></div>`;
  }
}

async function renderOwnerDashboard() {
  const members = await fetchMembers();
  const payments = await fetchRecentPayments();
  const attendance = await fetchTodayAttendance();
  const trainers = await fetchTrainers();
  const metrics = buildOwnerMetrics(members, attendance);

  dashboardView.innerHTML = `
    ${renderHeader("Owner Dashboard", currentProfile.full_name, "Full permission to manage members, dues, attendance, and plan updates")}
    <section class="metrics-grid">
      ${renderMetric("Total Members", metrics.totalMembers, "Live member base")}
      ${renderMetric("Present Today", metrics.presentToday, `Attendance on ${formatDate(todayDate())}`)}
      ${renderMetric("Pending Fees", metrics.pendingCount, "Members with dues this month")}
      ${renderMetric("Outstanding", `Rs ${metrics.totalDue}`, "Current month due amount")}
    </section>

    <section class="dashboard-grid">
      <div class="table-card">
        <p class="section-label">Members Overview</p>
        <h3>Live roster, dues, and attendance</h3>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Plan</th>
                <th>Trainer</th>
                <th>Paid This Month</th>
                <th>Due</th>
                <th>Today</th>
              </tr>
            </thead>
            <tbody>
              ${members.map((member) => `
                <tr>
                  <td><strong>${member.profile_name}</strong><br /><span class="small-note">${member.member_code} | ${member.phone || "-"}</span></td>
                  <td>${member.plan_name}<br /><span class="small-note">Monthly Rs ${member.monthly_fee}</span></td>
                  <td>${member.assigned_trainer_name || "Not assigned"}</td>
                  <td>Rs ${member.monthly_paid}</td>
                  <td>${moneyBadge(member.current_due)}</td>
                  <td>${attendanceCell(member.today_status)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="twocol-grid">
        <div class="info-card">
          <p class="section-label">Owner Actions</p>
          <h3>Update plan, fee, or attendance</h3>
          <form id="ownerMemberForm" class="form-grid">
            <label>
              Member
              <select id="ownerMemberId">${memberOptions(members)}</select>
            </label>
            <label>
              Assigned Trainer
              <select id="ownerTrainerId">
                <option value="">No trainer</option>
                ${trainers.map((trainer) => `<option value="${trainer.id}">${trainer.full_name}</option>`).join("")}
              </select>
            </label>
            <label>
              Plan Name
              <input id="ownerPlanName" type="text" placeholder="Strength Pro" />
            </label>
            <label>
              Monthly Fee
              <input id="ownerMonthlyFee" type="number" min="0" step="1" placeholder="1800" />
            </label>
            <label>
              Attendance Status
              <select id="ownerAttendanceStatus">
                <option value="Present">Present</option>
                <option value="Absent">Absent</option>
              </select>
            </label>
            <label>
              Payment Entry
              <input id="ownerPaymentAmount" type="number" min="0" step="1" placeholder="0" />
            </label>
            <label class="full-span">
              Note
              <input id="ownerNote" type="text" placeholder="Correction, received cash, fee revision, etc." />
            </label>
            <div class="inline-actions full-span">
              <button type="submit" class="primary-btn">Save owner changes</button>
              <button type="button" id="ownerLoadMember" class="ghost-btn">Load member data</button>
            </div>
            <p id="ownerMessage" class="message full-span"></p>
          </form>
        </div>

        <div class="list-card">
          <p class="section-label">Live Activity</p>
          <h3>Recent payments and attendance</h3>
          <ul class="activity-list">
            ${buildActivityItems(payments, attendance).map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </div>
      </div>
    </section>
  `;

  bindSharedActions();
  bindOwnerActions(members);
}
async function renderTrainerDashboard() {
  const members = await fetchMembers();
  const todayAttendance = await fetchTodayAttendance();

  dashboardView.innerHTML = `
    ${renderHeader("Trainer Dashboard", currentProfile.full_name, "Entry-only operational access for attendance and fee collection")}
    <section class="metrics-grid">
      ${renderMetric("Members Visible", members.length, "All active members")}
      ${renderMetric("Present Today", todayAttendance.filter((entry) => entry.status === "Present").length, "Live attendance count")}
      ${renderMetric("Pending Fees", members.filter((member) => member.current_due > 0).length, "Members requiring follow-up")}
      ${renderMetric("Your Role", "Trainer", "No update permission on member master data")}
    </section>

    <section class="dashboard-grid">
      <div class="table-card">
        <p class="section-label">Operations View</p>
        <h3>Live members with fee and attendance status</h3>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Plan</th>
                <th>Paid</th>
                <th>Due</th>
                <th>Today</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              ${members.map((member) => `
                <tr>
                  <td><strong>${member.profile_name}</strong><br /><span class="small-note">${member.member_code}</span></td>
                  <td>${member.plan_name}</td>
                  <td>Rs ${member.monthly_paid}</td>
                  <td>${moneyBadge(member.current_due)}</td>
                  <td>${attendanceCell(member.today_status)}</td>
                  <td>${locationCell(member.last_distance)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="twocol-grid">
        <div class="info-card">
          <p class="section-label">Attendance Entry</p>
          <h3>Add today attendance</h3>
          <form id="trainerAttendanceForm" class="form-grid">
            <label>
              Member
              <select id="trainerAttendanceMember">${memberOptions(members)}</select>
            </label>
            <label>
              Status
              <select id="trainerAttendanceStatus">
                <option value="Present">Present</option>
                <option value="Absent">Absent</option>
              </select>
            </label>
            <label class="full-span">
              Note
              <input id="trainerAttendanceNote" type="text" placeholder="Optional note" />
            </label>
            <button type="submit" class="primary-btn full-span">Add attendance entry</button>
            <p id="trainerAttendanceMessage" class="message full-span"></p>
          </form>
        </div>

        <div class="info-card">
          <p class="section-label">Fee Entry</p>
          <h3>Create payment entry</h3>
          <form id="trainerPaymentForm" class="form-grid">
            <label>
              Member
              <select id="trainerPaymentMember">${memberOptions(members)}</select>
            </label>
            <label>
              Amount
              <input id="trainerPaymentAmount" type="number" min="1" step="1" required />
            </label>
            <label class="full-span">
              Note
              <input id="trainerPaymentNote" type="text" placeholder="Cash, UPI, partial fee, etc." />
            </label>
            <button type="submit" class="primary-btn full-span">Save payment entry</button>
            <p id="trainerPaymentMessage" class="message full-span"></p>
          </form>
          <p class="small-note">Trainers can create entries, but cannot edit member plan, fee, or existing records.</p>
        </div>
      </div>
    </section>
  `;

  bindSharedActions();
  bindTrainerActions();
}

async function renderMemberDashboard() {
  const member = await fetchMyMember();
  if (!member) {
    dashboardView.innerHTML = `
      ${renderHeader("Member Dashboard", currentProfile.full_name, "Member record not found")}
      <div class="panel-card auth-card">
        <p class="message error">This logged-in account does not have a member record yet. Create or sync the member row in Supabase.</p>
      </div>
    `;
    bindSharedActions();
    return;
  }

  const attendance = await fetchMemberAttendance(member.id);
  const payments = await fetchMemberPayments(member.id);
  const presentCount = attendance.filter((entry) => entry.status === "Present").length;
  const thisMonthPaid = getThisMonthPaid(payments);
  const due = Math.max((member.monthly_fee || 0) - thisMonthPaid, 0);
  const lastLocation = attendance.find((entry) => entry.distance_meters !== null && entry.distance_meters !== undefined);

  dashboardView.innerHTML = `
    ${renderHeader("Member Dashboard", currentProfile.full_name, "Your own attendance, fees, and location check-in records")}
    <section class="metrics-grid">
      ${renderMetric("Plan", member.plan_name, "Current membership plan")}
      ${renderMetric("Monthly Fee", `Rs ${member.monthly_fee}`, "Current month expected amount")}
      ${renderMetric("Paid This Month", `Rs ${thisMonthPaid}`, "Collected in current billing month")}
      ${renderMetric("Outstanding", `Rs ${due}`, due === 0 ? "No dues pending" : "Pending fees still due")}
    </section>

    <section class="dashboard-grid">
      <div class="table-card">
        <p class="section-label">My Record</p>
        <h3>Attendance and payments</h3>
        <div class="member-highlight">
          <div class="kv-row"><span>Member Code</span><strong>${member.member_code}</strong></div>
          <div class="kv-row"><span>Join Date</span><strong>${formatDate(member.join_date)}</strong></div>
          <div class="kv-row"><span>Present Count</span><strong>${presentCount}</strong></div>
          <div class="kv-row"><span>Latest Location Check</span><strong>${lastLocation ? `${Math.round(lastLocation.distance_meters)}m from gym` : "No location log"}</strong></div>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Source</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${attendance.map((entry) => `
                <tr>
                  <td>${formatDate(entry.attendance_date)}</td>
                  <td>${attendanceCell(entry.status)}</td>
                  <td>${entry.source || "-"}</td>
                  <td>${entry.notes || "-"}</td>
                </tr>
              `).join("") || `<tr><td colspan="4">No attendance records yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      <div class="twocol-grid">
        <div class="info-card">
          <p class="section-label">Location Check-In</p>
          <h3>Mark attendance from gym location</h3>
          <p class="small-note">Browser location allow kijiye. Attendance sirf gym radius ${gym.radiusMeters} meters ke andar mark hogi.</p>
          <button id="memberLocationBtn" class="primary-btn">Check location and mark attendance</button>
          <p id="memberLocationMessage" class="message"></p>
          <div class="kv-row"><span>Gym</span><strong>${gym.name}</strong></div>
          <div class="kv-row"><span>Address</span><strong>${gym.address}</strong></div>
        </div>

        <div class="list-card">
          <p class="section-label">Payment History</p>
          <h3>Your fee entries</h3>
          <ul class="activity-list">
            ${payments.map((payment) => `<li>Rs ${payment.amount} on ${formatDate(payment.payment_date)} by ${payment.creator_name || "system"}${payment.note ? `, note: ${payment.note}` : ""}</li>`).join("") || "<li>No payments yet.</li>"}
          </ul>
        </div>
      </div>
    </section>
  `;

  bindSharedActions();
  bindMemberActions(member);
}

function bindSharedActions() {
  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
  });

  document.getElementById("refreshBtn")?.addEventListener("click", async () => {
    await renderDashboard();
  });
}

function bindOwnerActions(members) {
  const memberSelect = document.getElementById("ownerMemberId");
  const trainerSelect = document.getElementById("ownerTrainerId");
  const planInput = document.getElementById("ownerPlanName");
  const feeInput = document.getElementById("ownerMonthlyFee");
  const attendanceStatus = document.getElementById("ownerAttendanceStatus");
  const paymentAmount = document.getElementById("ownerPaymentAmount");
  const noteInput = document.getElementById("ownerNote");
  const loadButton = document.getElementById("ownerLoadMember");
  const form = document.getElementById("ownerMemberForm");
  const message = document.getElementById("ownerMessage");

  const loadMember = () => {
    const member = members.find((item) => item.id === memberSelect.value);
    if (!member) return;
    trainerSelect.value = member.assigned_trainer || "";
    planInput.value = member.plan_name || "";
    feeInput.value = member.monthly_fee || 0;
    attendanceStatus.value = member.today_status === "Absent" ? "Absent" : "Present";
    paymentAmount.value = "";
    noteInput.value = "";
  };

  loadButton.addEventListener("click", loadMember);
  memberSelect.addEventListener("change", loadMember);
  loadMember();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const memberId = memberSelect.value;
    const monthlyFee = Number(feeInput.value || 0);
    const payment = Number(paymentAmount.value || 0);
    const note = noteInput.value.trim();

    try {
      const { error: memberError } = await supabaseClient
        .from("members")
        .update({
          plan_name: planInput.value.trim() || "General",
          monthly_fee: monthlyFee,
          assigned_trainer: trainerSelect.value || null,
        })
        .eq("id", memberId);

      if (memberError) throw memberError;

      const attendancePayload = {
        member_id: memberId,
        attendance_date: todayDate(),
        status: attendanceStatus.value,
        source: "owner_update",
        marked_by: currentProfile.id,
        notes: note || null,
      };

      const { error: attendanceError } = await supabaseClient
        .from("attendance")
        .upsert(attendancePayload, { onConflict: "member_id,attendance_date" });

      if (attendanceError) throw attendanceError;

      if (payment > 0) {
        const { error: paymentError } = await supabaseClient
          .from("payments")
          .insert({
            member_id: memberId,
            amount: payment,
            payment_date: todayDate(),
            billing_month: currentMonthStart(),
            note: note || "Owner payment update",
            created_by: currentProfile.id,
          });

        if (paymentError) throw paymentError;
      }

      setMessage(message, "Owner changes saved to live database.", "success");
      await renderDashboard();
    } catch (error) {
      console.error(error);
      setMessage(message, error.message, "error");
    }
  });
}

function bindTrainerActions() {
  const attendanceForm = document.getElementById("trainerAttendanceForm");
  const attendanceMessage = document.getElementById("trainerAttendanceMessage");
  const paymentForm = document.getElementById("trainerPaymentForm");
  const paymentMessage = document.getElementById("trainerPaymentMessage");

  attendanceForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      const { error } = await supabaseClient.from("attendance").insert({
        member_id: document.getElementById("trainerAttendanceMember").value,
        attendance_date: todayDate(),
        status: document.getElementById("trainerAttendanceStatus").value,
        source: "trainer_entry",
        marked_by: currentProfile.id,
        notes: document.getElementById("trainerAttendanceNote").value.trim() || null,
      });

      if (error) throw error;
      setMessage(attendanceMessage, "Attendance entry saved.", "success");
      attendanceForm.reset();
      await renderDashboard();
    } catch (error) {
      console.error(error);
      setMessage(attendanceMessage, "Attendance entry failed. If today already marked, owner should update it.", "error");
    }
  });

  paymentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const amount = Number(document.getElementById("trainerPaymentAmount").value || 0);

    if (amount <= 0) {
      setMessage(paymentMessage, "Amount must be greater than zero.", "error");
      return;
    }

    try {
      const { error } = await supabaseClient.from("payments").insert({
        member_id: document.getElementById("trainerPaymentMember").value,
        amount,
        payment_date: todayDate(),
        billing_month: currentMonthStart(),
        note: document.getElementById("trainerPaymentNote").value.trim() || null,
        created_by: currentProfile.id,
      });

      if (error) throw error;
      setMessage(paymentMessage, "Payment entry saved.", "success");
      paymentForm.reset();
      await renderDashboard();
    } catch (error) {
      console.error(error);
      setMessage(paymentMessage, error.message, "error");
    }
  });
}

function bindMemberActions(member) {
  const button = document.getElementById("memberLocationBtn");
  const message = document.getElementById("memberLocationMessage");

  button.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setMessage(message, "Geolocation supported nahi hai.", "error");
      return;
    }

    setMessage(message, "Location verify ki ja rahi hai...", "success");

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const distance = calculateDistanceMeters(
          position.coords.latitude,
          position.coords.longitude,
          gym.lat,
          gym.lng,
        );

        if (distance > gym.radiusMeters) {
          setMessage(message, `Aap ${Math.round(distance)}m door ho. Attendance radius ${gym.radiusMeters}m hai.`, "error");
          return;
        }

        try {
          const { error } = await supabaseClient.from("attendance").upsert({
            member_id: member.id,
            attendance_date: todayDate(),
            status: "Present",
            source: "member_location",
            marked_by: currentProfile.id,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            distance_meters: Math.round(distance),
            notes: "Marked via location check-in",
          }, { onConflict: "member_id,attendance_date" });

          if (error) throw error;
          setMessage(message, `Attendance marked. Aap gym se ${Math.round(distance)}m distance par ho.`, "success");
          await renderDashboard();
        } catch (error) {
          console.error(error);
          setMessage(message, error.message, "error");
        }
      },
      () => setMessage(message, "Location permission deny ho gayi ya unavailable hai.", "error"),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });
}

async function fetchMembers() {
  const { data: members, error } = await supabaseClient
    .from("members")
    .select(`
      id,
      profile_id,
      member_code,
      plan_name,
      monthly_fee,
      join_date,
      status,
      assigned_trainer,
      profile:profiles!members_profile_id_fkey(full_name, phone, role),
      trainer:profiles!members_assigned_trainer_fkey(full_name)
    `)
    .order("join_date", { ascending: false });

  if (error) throw error;

  const memberIds = members.map((member) => member.id);
  const [paymentMap, attendanceMap, locationMap] = await Promise.all([
    fetchMonthlyPaymentMap(memberIds),
    fetchTodayAttendanceMap(memberIds),
    fetchLatestLocationMap(memberIds),
  ]);

  return members
    .filter((member) => member.profile?.role === "member")
    .map((member) => ({
      ...member,
      profile_name: member.profile?.full_name || "Unknown",
      phone: member.profile?.phone || "",
      assigned_trainer_name: member.trainer?.full_name || "",
      monthly_paid: paymentMap.get(member.id) || 0,
      today_status: attendanceMap.get(member.id) || "No entry",
      last_distance: locationMap.get(member.id),
      current_due: Math.max((member.monthly_fee || 0) - (paymentMap.get(member.id) || 0), 0),
    }));
}
async function fetchMyMember() {
  const { data, error } = await supabaseClient
    .from("members")
    .select("id, profile_id, member_code, plan_name, monthly_fee, join_date, status")
    .eq("profile_id", currentProfile.id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function fetchMemberAttendance(memberId) {
  const { data, error } = await supabaseClient
    .from("attendance")
    .select("attendance_date, status, source, notes, distance_meters")
    .eq("member_id", memberId)
    .order("attendance_date", { ascending: false })
    .limit(25);

  if (error) throw error;
  return data;
}

async function fetchMemberPayments(memberId) {
  const { data, error } = await supabaseClient
    .from("payments")
    .select("amount, payment_date, note, creator:profiles!payments_created_by_fkey(full_name)")
    .eq("member_id", memberId)
    .order("payment_date", { ascending: false })
    .limit(20);

  if (error) throw error;
  return data.map((item) => ({ ...item, creator_name: item.creator?.full_name || "" }));
}

async function fetchTrainers() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id, full_name")
    .eq("role", "trainer")
    .order("full_name");

  if (error) throw error;
  return data;
}

async function fetchRecentPayments() {
  const { data, error } = await supabaseClient
    .from("payments")
    .select("amount, payment_date, note, member:members(member_code, profile:profiles!members_profile_id_fkey(full_name)), creator:profiles!payments_created_by_fkey(full_name)")
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) throw error;

  return data.map((payment) => ({
    amount: payment.amount,
    payment_date: payment.payment_date,
    note: payment.note,
    member_name: payment.member?.profile?.full_name || payment.member?.member_code || "Member",
    creator_name: payment.creator?.full_name || "Unknown",
  }));
}

async function fetchTodayAttendance() {
  const { data, error } = await supabaseClient
    .from("attendance")
    .select("status, attendance_date, source, notes, member:members(member_code, profile:profiles!members_profile_id_fkey(full_name)), marker:profiles!attendance_marked_by_fkey(full_name)")
    .eq("attendance_date", todayDate())
    .order("check_in_time", { ascending: false })
    .limit(8);

  if (error) throw error;

  return data.map((entry) => ({
    status: entry.status,
    attendance_date: entry.attendance_date,
    source: entry.source,
    notes: entry.notes,
    member_name: entry.member?.profile?.full_name || entry.member?.member_code || "Member",
    marker_name: entry.marker?.full_name || "Unknown",
  }));
}

async function fetchMonthlyPaymentMap(memberIds) {
  if (!memberIds.length) return new Map();

  const { data, error } = await supabaseClient
    .from("payments")
    .select("member_id, amount")
    .in("member_id", memberIds)
    .eq("billing_month", currentMonthStart());

  if (error) throw error;

  const map = new Map();
  data.forEach((row) => {
    map.set(row.member_id, (map.get(row.member_id) || 0) + Number(row.amount || 0));
  });
  return map;
}

async function fetchTodayAttendanceMap(memberIds) {
  if (!memberIds.length) return new Map();

  const { data, error } = await supabaseClient
    .from("attendance")
    .select("member_id, status")
    .in("member_id", memberIds)
    .eq("attendance_date", todayDate());

  if (error) throw error;

  const map = new Map();
  data.forEach((row) => map.set(row.member_id, row.status));
  return map;
}

async function fetchLatestLocationMap(memberIds) {
  if (!memberIds.length) return new Map();

  const { data, error } = await supabaseClient
    .from("attendance")
    .select("member_id, distance_meters, check_in_time")
    .in("member_id", memberIds)
    .not("distance_meters", "is", null)
    .order("check_in_time", { ascending: false });

  if (error) throw error;

  const map = new Map();
  data.forEach((row) => {
    if (!map.has(row.member_id)) {
      map.set(row.member_id, row.distance_meters);
    }
  });
  return map;
}

function buildOwnerMetrics(members, attendance) {
  return {
    totalMembers: members.length,
    presentToday: attendance.filter((entry) => entry.status === "Present").length,
    pendingCount: members.filter((member) => member.current_due > 0).length,
    totalDue: members.reduce((sum, member) => sum + member.current_due, 0),
  };
}

function buildActivityItems(payments, attendance) {
  const paymentItems = payments.map((item) => `${item.member_name} paid Rs ${item.amount} on ${formatDate(item.payment_date)} via entry by ${item.creator_name}.`);
  const attendanceItems = attendance.map((item) => `${item.member_name} marked ${item.status.toLowerCase()} on ${formatDate(item.attendance_date)} by ${item.marker_name}.`);
  return [...paymentItems, ...attendanceItems].slice(0, 6);
}

function renderHeader(title, userName, subtitle) {
  return `
    <div class="dashboard-top">
      <div>
        <p class="section-label">DEN Fitness Live ERP</p>
        <h2>${title}</h2>
        <p class="muted">${subtitle}</p>
      </div>
      <div>
        <p><strong>${userName}</strong> <span class="status-pill status-active">${currentProfile.role}</span></p>
        <p class="muted">${gym.address}</p>
        <div class="quick-actions">
          <button class="secondary-btn" id="refreshBtn">Refresh</button>
          <button class="ghost-btn" id="logoutBtn">Logout</button>
        </div>
      </div>
    </div>
  `;
}

function renderMetric(label, value, caption) {
  return `
    <article class="metric-card">
      <span class="kpi-label">${label}</span>
      <strong>${value}</strong>
      <p class="muted">${caption}</p>
    </article>
  `;
}
function memberOptions(members) {
  return members.map((member) => `<option value="${member.id}">${member.profile_name} (${member.member_code})</option>`).join("");
}

function attendanceCell(status) {
  if (status === "Present") return '<span class="status-pill status-present">Present</span>';
  if (status === "Absent") return '<span class="status-pill status-absent">Absent</span>';
  return '<span class="status-pill status-due">No entry</span>';
}

function locationCell(distance) {
  if (distance === undefined || distance === null) return '<span class="status-pill status-due">No check</span>';
  if (distance <= gym.radiusMeters) return '<span class="status-pill status-inside">Inside zone</span>';
  return `<span class="status-pill status-outside">${Math.round(distance)}m away</span>`;
}

function moneyBadge(amount) {
  if (amount <= 0) return '<span class="status-pill status-paid">Paid</span>';
  return `<span class="status-pill status-overdue">Rs ${amount} due</span>`;
}

function setMessage(element, text, type) {
  element.textContent = text;
  element.className = `message ${type}`;
}

function getThisMonthPaid(payments) {
  return payments
    .filter((payment) => payment.payment_date?.startsWith(currentMonthStart().slice(0, 7)))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function currentMonthStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRadians = (degree) => (degree * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}
