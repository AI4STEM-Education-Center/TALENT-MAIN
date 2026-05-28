import asyncio
import aiohttp
import time
import argparse
import random
import string
import os

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.ticker as ticker
    import numpy as np
    from tqdm import tqdm
    from tqdm.asyncio import tqdm_asyncio
    from prettytable import PrettyTable
    import json
except ImportError:
    print("Packages missing. Please install with: uv pip install matplotlib numpy tqdm prettytable")
    exit(1)

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

def is_cloudflare_block(status, body_bytes):
    """Detect if a response is a Cloudflare challenge/block page instead of real API data."""
    if status in (403, 503):
        text = body_bytes.decode("utf-8", errors="replace")[:2000]
        if any(sig in text for sig in ("cf-browser-verification", "cloudflare", "challenge-platform", "ray ID", "Attention Required")):
            return True
    if status == 200:
        text = body_bytes.decode("utf-8", errors="replace")[:500]
        if text.lstrip().startswith("<!DOCTYPE") or text.lstrip().startswith("<html"):
            return True
    return False

async def get_csrf_token(session, base_url):
    url = f"{base_url}/api/auth/csrf"
    try:
        async with session.get(url) as res:
            body = await res.read()
            if is_cloudflare_block(res.status, body):
                print(f"  [BLOCKED] CSRF request blocked by Cloudflare (status {res.status})")
                return None
            if res.status == 200:
                data = await res.json()
                return data.get("csrfToken")
            print(f"  [WARN] CSRF endpoint returned status {res.status}")
    except Exception as e:
        print(f"  [ERROR] CSRF request failed: {e}")
    return None

async def login(session, base_url, identifier, password):
    csrf_token = await get_csrf_token(session, base_url)
    if not csrf_token:
        print("  [ERROR] Could not obtain CSRF token — login impossible")
        return False
    url = f"{base_url}/api/auth/callback/credentials"
    data = {"redirect": "false", "identifier": identifier, "password": password, "csrfToken": csrf_token}
    headers = {**BROWSER_HEADERS, "Content-Type": "application/x-www-form-urlencoded"}
    try:
        async with session.post(url, data=data, headers=headers, allow_redirects=False) as res:
            body = await res.read()
            if is_cloudflare_block(res.status, body):
                print(f"  [BLOCKED] Login blocked by Cloudflare (status {res.status})")
                return False
            ok = res.status in (200, 302, 303) and (
                'auth' in str(session.cookie_jar) or any('auth' in k.lower() for k in res.cookies.keys())
            )
            if not ok:
                print(f"  [WARN] Login returned status {res.status}, cookies: {list(res.cookies.keys())}")
            return ok
    except Exception as e:
        print(f"  [ERROR] Login request failed: {e}")
        return False

async def verify_setup(session, base_url, class_id, expected_topics, expected_subtopics_per_topic, expected_students):
    """Read back created data and verify it actually reached the server."""
    print("\n  [VERIFY] Reading back created data to confirm writes persisted...")
    errors = []

    async with session.get(f"{base_url}/api/classes/{class_id}") as res:
        body = await res.read()
        if is_cloudflare_block(res.status, body):
            errors.append("GET class blocked by Cloudflare")
        elif res.status != 200:
            errors.append(f"GET class returned {res.status}")
        else:
            try:
                cls = await res.json()
                actual_students = len(cls.get("students", cls.get("enrollments", [])))
                if actual_students < expected_students:
                    errors.append(f"Expected >= {expected_students} students, found {actual_students}")
                else:
                    print(f"  [VERIFY] Class OK — {actual_students} students enrolled")
            except Exception as e:
                errors.append(f"Class response not valid JSON: {e}")

    async with session.get(f"{base_url}/api/classes/{class_id}/topics") as res:
        body = await res.read()
        if is_cloudflare_block(res.status, body):
            errors.append("GET class topics blocked by Cloudflare")
        elif res.status != 200:
            errors.append(f"GET class topics returned {res.status}")
        else:
            try:
                data = await res.json()
                topics_list = data if isinstance(data, list) else data.get("topics", data.get("data", []))
                actual_topics = len(topics_list)
                if actual_topics < expected_topics:
                    errors.append(f"Expected {expected_topics} topics, found {actual_topics}")
                else:
                    print(f"  [VERIFY] Topics OK — {actual_topics} topics found")
                    if topics_list:
                        sample = topics_list[0]
                        subs = sample.get("subtopics", sample.get("children", []))
                        actual_subs = len(subs) if isinstance(subs, list) else 0
                        if actual_subs > 0:
                            print(f"  [VERIFY] Subtopics OK — sample topic has {actual_subs} subtopics")
                        else:
                            print(f"  [VERIFY] Subtopics — could not count from response shape (may still be fine)")
            except Exception as e:
                errors.append(f"Topics response not valid JSON: {e}")

    if errors:
        print(f"\n  [VERIFY FAILED] {len(errors)} issue(s):")
        for err in errors:
            print(f"    - {err}")
        return False
    print("  [VERIFY] All write verification checks passed!")
    return True


async def setup_test_data(session, base_url, num_topics, num_subtopics):
    """Returns (class_id, [topic_ids]) for later cleanup."""
    print(f"\n--- Setting up Data ({num_topics} Topics, {num_subtopics} Subtopics/Topic) ---")
    topic_ids = []
    cf_blocks = 0

    print("1. Creating Benchmark Class...")
    async with session.post(f"{base_url}/api/classes", json={"name": f"Benchmark Class {num_topics}x{num_subtopics} {int(time.time())}"}) as res:
        body = await res.read()
        if is_cloudflare_block(res.status, body):
            print(f"  [BLOCKED] Class creation blocked by Cloudflare! Aborting.")
            return None, []
        if res.status != 201:
            print(f"Failed to create class! Status {res.status}: {body.decode('utf-8', errors='replace')[:500]}")
            return None, []
        cls_data = await res.json()
        class_id = cls_data["id"]

    print(f"2. Creating {num_topics} Topics and {num_topics * num_subtopics} Subtopics...")
    for i in tqdm(range(1, num_topics + 1), desc="Topics Setup"):
        async with session.post(f"{base_url}/api/topics", json={"name": f"Topic {i}", "order": i}) as res:
            body = await res.read()
            if is_cloudflare_block(res.status, body):
                cf_blocks += 1
                continue
            if res.status != 201: continue
            topic_data = await res.json()
            topic_id = topic_data["id"]
            topic_ids.append(topic_id)

        await session.post(f"{base_url}/api/classes/{class_id}/topics", json={"topicId": topic_id})
        await session.patch(f"{base_url}/api/classes/{class_id}/topics", json={"topicId": topic_id, "published": True})

        sem = asyncio.Semaphore(100)
        sub_blocks = 0
        async def create_subtopic(j, t_id, t_idx):
            nonlocal sub_blocks
            async with sem:
                async with session.post(f"{base_url}/api/topics/{t_id}/subtopics", json={"name": f"Subtopic {t_idx}.{j}", "order": j}) as r:
                    body = await r.read()
                    if is_cloudflare_block(r.status, body):
                        sub_blocks += 1

        await asyncio.gather(*[create_subtopic(j, topic_id, i) for j in range(1, num_subtopics + 1)])
        if sub_blocks > 0:
            cf_blocks += sub_blocks

    if cf_blocks > 0:
        print(f"\n  [WARNING] {cf_blocks} requests were blocked by Cloudflare during setup!")

    print("3. Generating Invitation Link...")
    async with session.post(f"{base_url}/api/invitations", json={"classId": class_id}) as res:
        body = await res.read()
        if is_cloudflare_block(res.status, body):
            print("  [BLOCKED] Invitation creation blocked by Cloudflare!")
            return None, []
        inv_data = await res.json()
        invite_token = inv_data["token"]

    print("4. Enrolling 20 Students...")
    semaphore = asyncio.Semaphore(20)
    enroll_results = {"success": 0, "failed": 0, "cf_blocked": 0}

    async def enroll_student(s_idx):
        random_str = ''.join(random.choices(string.ascii_letters, k=6))
        payload = {
            "firstName": "Test",
            "lastName": f"Student{s_idx}",
            "username": f"bm_{int(time.time())}_{s_idx}_{random_str}",
            "email": f"bm_{int(time.time())}_{s_idx}_{random_str}@example.com",
            "password": "Password123!"
        }
        async with semaphore:
            async with aiohttp.ClientSession(headers=BROWSER_HEADERS) as isolated_session:
                async with isolated_session.post(f"{base_url}/api/invitations/{invite_token}", json=payload) as res:
                    body = await res.read()
                    if is_cloudflare_block(res.status, body):
                        enroll_results["cf_blocked"] += 1
                    elif res.status == 200:
                        enroll_results["success"] += 1
                    else:
                        enroll_results["failed"] += 1

    await tqdm_asyncio.gather(*[enroll_student(s) for s in range(20)], desc="Student Setup")
    print(f"   -> Enrollment: {enroll_results['success']} ok, {enroll_results['failed']} failed, {enroll_results['cf_blocked']} CF-blocked")

    await verify_setup(session, base_url, class_id, num_topics, num_subtopics, enroll_results['success'])

    print("   -> Data setup complete.")
    return class_id, topic_ids


async def cleanup_test_data(session, base_url, class_ids, topic_ids):
    """Delete all benchmark-created topics (cascades to subtopics) and classes."""
    total = len(topic_ids) + len(class_ids)
    if total == 0:
        return
    print(f"\n--- Cleaning up benchmark data ({len(topic_ids)} topics, {len(class_ids)} classes) ---")

    sem = asyncio.Semaphore(20)

    async def delete_topic(tid):
        async with sem:
            try:
                async with session.delete(f"{base_url}/api/topics/{tid}") as res:
                    await res.read()
            except:
                pass

    async def delete_class(cid):
        async with sem:
            try:
                async with session.delete(f"{base_url}/api/classes/{cid}") as res:
                    await res.read()
            except:
                pass

    print("  Deleting topics (subtopics cascade)...")
    await tqdm_asyncio.gather(*[delete_topic(t) for t in topic_ids], desc="Deleting topics")

    print("  Deleting classes...")
    await tqdm_asyncio.gather(*[delete_class(c) for c in class_ids], desc="Deleting classes")

    print("  -> Cleanup complete. Note: benchmark student accounts remain (no delete API).")

async def benchmark_endpoint(session, url, method="GET", json_payload=None):
    start = time.time()
    try:
        if method == "GET":
            async with session.get(url) as res:
                body = await res.read()
                cf = is_cloudflare_block(res.status, body)
                return time.time() - start, res.status, cf
        else:
            async with session.post(url, json=json_payload) as res:
                body = await res.read()
                cf = is_cloudflare_block(res.status, body)
                return time.time() - start, res.status, cf
    except Exception:
        return time.time() - start, 500, False

async def worker(session, url, requests_per_worker, results_dict, method="GET", payload=None, pbar=None):
    for _ in range(requests_per_worker):
        duration, status, cf_blocked = await benchmark_endpoint(session, url, method, payload)
        results_dict['times'].append(duration)
        if cf_blocked:
            results_dict['cf_blocked'] += 1
            results_dict['failed'] += 1
        elif status in (200, 201):
            results_dict['success'] += 1
        else:
            results_dict['failed'] += 1
        if pbar:
            pbar.update(1)

async def run_single_size_test(base_url, identifier, password, concurrency, total_requests, num_topics, num_subtopics):
    """Runs one configuration, cleans up after benchmarking, and returns the summary."""
    base_url = base_url.rstrip('/')
    cookie_jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=cookie_jar, headers=BROWSER_HEADERS) as session:
        logged_in = await login(session, base_url, identifier, password)
        if not logged_in:
            print("Login failed! Ensure NextAuth is working and credentials are correct.")
            return None

        class_id, topic_ids = await setup_test_data(session, base_url, num_topics, num_subtopics)
        if not class_id:
            return None

        endpoints_to_test = {
            "GET_All_Classes": {"path": "/api/classes", "method": "GET"},
            "GET_Heavy_Class_Payload": {"path": f"/api/classes/{class_id}", "method": "GET"},
            "GET_Topics_List": {"path": "/api/topics", "method": "GET"},
            "GET_Class_Topics": {"path": f"/api/classes/{class_id}/topics", "method": "GET"},
        }

        results = {
            name: {'success': 0, 'failed': 0, 'cf_blocked': 0, 'times': [], 'total_time': 0} for name in endpoints_to_test
        }

        requests_per_worker = max(1, total_requests // concurrency)

        for ep_name, ep_config in endpoints_to_test.items():
            url = f"{base_url}{ep_config['path']}"
            method = ep_config.get('method', 'GET')
            payload = ep_config.get('payload')

            phase_start = time.time()
            total_ep_requests = requests_per_worker * concurrency
            with tqdm(total=total_ep_requests, desc=f"Testing {ep_name}") as pbar:
                tasks = [
                    asyncio.create_task(worker(session, url, requests_per_worker, results[ep_name], method, payload, pbar))
                    for _ in range(concurrency)
                ]
                await asyncio.gather(*tasks)
            phase_duration = time.time() - phase_start
            results[ep_name]['total_time'] = phase_duration

        total_cf_blocked = sum(stats['cf_blocked'] for stats in results.values())
        if total_cf_blocked > 0:
            print(f"\n  [WARNING] {total_cf_blocked} benchmark requests were blocked by Cloudflare!")
            for ep_name, stats in results.items():
                if stats['cf_blocked'] > 0:
                    print(f"    {ep_name}: {stats['cf_blocked']} blocked")

        summary = {}
        for ep_name, stats in results.items():
            t_total = len(stats['times'])
            if t_total == 0: continue

            avg_time = sum(stats['times']) / t_total
            max_time = max(stats['times'])
            phase_time = stats['total_time']
            throughput = (stats['success'] + stats['failed']) / phase_time if phase_time > 0 else 0

            summary[ep_name] = {
                'avg_latency': avg_time,
                'max_latency': max_time,
                'throughput': throughput
            }

        await cleanup_test_data(session, base_url, [class_id], topic_ids)

        return summary

ENDPOINT_LABELS = {
    "GET_All_Classes": "List Classes",
    "GET_Heavy_Class_Payload": "Single Class (heavy)",
    "GET_Topics_List": "List Topics",
    "GET_Class_Topics": "Class Topics",
}

COLORS = ["#2563eb", "#dc2626", "#16a34a", "#ea580c"]

def plot_results(sizes, all_summaries, plot_name):
    print("\n--- GENERATING PLOTS ---")
    endpoints = list(all_summaries[0].keys())

    RATIO_TARGET = 1000

    # Group A: fixed 5 topics, varying subtopics → volume scaling (50 → 5000)
    ga_idx = [i for i, (t, _) in enumerate(sizes) if t == 5]
    # Group B: fixed 1000 total items, varying ratio → topic vs subtopic trade-off
    gb_idx = [i for i, (t, s) in enumerate(sizes) if t * s == RATIO_TARGET]
    gb_idx.sort(key=lambda i: sizes[i][0])

    ga_subtopics = [sizes[i][1] for i in ga_idx]
    ga_summaries = [all_summaries[i] for i in ga_idx]
    gb_labels = [f"{sizes[i][0]}T × {sizes[i][1]}S" for i in gb_idx]
    gb_summaries = [all_summaries[i] for i in gb_idx]

    fig = plt.figure(figsize=(18, 14))
    fig.patch.set_facecolor('#fafafa')
    fig.suptitle('API Benchmark Results',
                 fontsize=20, fontweight='bold', y=0.98, color='#1e293b')

    gs = fig.add_gridspec(2, 2, hspace=0.38, wspace=0.30,
                          left=0.07, right=0.95, top=0.91, bottom=0.08)

    def style_ax(ax, title, xlabel, ylabel):
        ax.set_facecolor('#ffffff')
        ax.set_title(title, fontsize=13, fontweight='bold', pad=12, color='#1e293b')
        ax.set_xlabel(xlabel, fontsize=11, color='#475569')
        ax.set_ylabel(ylabel, fontsize=11, color='#475569')
        ax.tick_params(colors='#64748b', labelsize=9)
        ax.grid(True, alpha=0.3, linestyle='--', color='#94a3b8')
        for spine in ax.spines.values():
            spine.set_color('#e2e8f0')

    # --- [0,0] Avg Latency scaling (Group A — fixed 5 topics) ---
    ax1 = fig.add_subplot(gs[0, 0])
    for idx, ep in enumerate(endpoints):
        vals = [s[ep]['avg_latency'] for s in ga_summaries]
        ax1.plot(ga_subtopics, vals, marker='o', markersize=7,
                 linewidth=2.2, label=ENDPOINT_LABELS.get(ep, ep),
                 color=COLORS[idx], zorder=3)
    ax1.set_xscale('log')
    ax1.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f'{int(x):,}'))
    style_ax(ax1, 'Avg Latency — Subtopic Scaling (5 Topics)',
             'Subtopics per Topic', 'Avg Latency (s)')
    ax1.legend(fontsize=8, loc='upper left', framealpha=0.9, edgecolor='#e2e8f0')

    # --- [0,1] Throughput scaling (Group A) ---
    ax2 = fig.add_subplot(gs[0, 1])
    for idx, ep in enumerate(endpoints):
        vals = [s[ep]['throughput'] for s in ga_summaries]
        ax2.plot(ga_subtopics, vals, marker='s', markersize=7,
                 linewidth=2.2, label=ENDPOINT_LABELS.get(ep, ep),
                 color=COLORS[idx], zorder=3)
    ax2.set_xscale('log')
    ax2.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f'{int(x):,}'))
    style_ax(ax2, 'Throughput — Subtopic Scaling (5 Topics)',
             'Subtopics per Topic', 'Throughput (req/s)')
    ax2.legend(fontsize=8, loc='upper right', framealpha=0.9, edgecolor='#e2e8f0')

    # --- [1,0] Ratio effect bar chart (Group B — ~500 items, varying ratio) ---
    ax3 = fig.add_subplot(gs[1, 0])
    x = np.arange(len(gb_labels))
    bar_width = 0.18
    for idx, ep in enumerate(endpoints):
        vals = [s[ep]['avg_latency'] for s in gb_summaries]
        offset = (idx - (len(endpoints) - 1) / 2) * bar_width
        bars = ax3.bar(x + offset, vals, bar_width,
                       label=ENDPOINT_LABELS.get(ep, ep),
                       color=COLORS[idx], edgecolor='white', linewidth=0.5, zorder=3)
        for bar, v in zip(bars, vals):
            ax3.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                     f'{v:.2f}', ha='center', va='bottom', fontsize=6.5, color='#475569')
    ax3.set_xticks(x)
    ax3.set_xticklabels(gb_labels, fontsize=9, fontweight='bold')
    style_ax(ax3, f'Ratio Effect on Latency (Fixed {RATIO_TARGET:,} Total Items)',
             'Configuration', 'Avg Latency (s)')
    ax3.legend(fontsize=8, loc='upper left', framealpha=0.9, edgecolor='#e2e8f0')

    # --- [1,1] Max latency scaling (Group A) ---
    ax4 = fig.add_subplot(gs[1, 1])
    for idx, ep in enumerate(endpoints):
        vals = [s[ep]['max_latency'] for s in ga_summaries]
        ax4.plot(ga_subtopics, vals, marker='^', markersize=7,
                 linewidth=2.2, label=ENDPOINT_LABELS.get(ep, ep),
                 color=COLORS[idx], linestyle='--', zorder=3)
    ax4.set_xscale('log')
    ax4.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f'{int(x):,}'))
    style_ax(ax4, 'Max (Worst-Case) Latency — Subtopic Scaling (5 Topics)',
             'Subtopics per Topic', 'Max Latency (s)')
    ax4.legend(fontsize=8, loc='upper left', framealpha=0.9, edgecolor='#e2e8f0')

    plt.savefig(plot_name, dpi=150, facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f"\n  Plot saved to {plot_name}")

async def run_1000_students_write_test(session, base_url):
    """Returns (summary_dict, class_id) so caller can clean up."""
    print("\n--- FINAL TEST: 1000 Concurrent Student Registrations ---")

    print("1. Creating dummy class for final write test...")
    async with session.post(f"{base_url}/api/classes", json={"name": f"1k Students Reg Test {int(time.time())}"}) as res:
        body = await res.read()
        if is_cloudflare_block(res.status, body):
            print("  [BLOCKED] Class creation blocked by Cloudflare!")
            return {'success': 0, 'failed': 1000, 'cf_blocked': 1000, 'duration': 0, 'throughput': 0, 'avg_latency': 0, 'max_latency': 0, 'min_latency': 0}, None
        cls_data = await res.json()
        class_id = cls_data["id"]

    print("2. Generating Invitation Link...")
    async with session.post(f"{base_url}/api/invitations", json={"classId": class_id}) as res:
        body = await res.read()
        if is_cloudflare_block(res.status, body):
            print("  [BLOCKED] Invitation creation blocked by Cloudflare!")
            return {'success': 0, 'failed': 1000, 'cf_blocked': 1000, 'duration': 0, 'throughput': 0, 'avg_latency': 0, 'max_latency': 0, 'min_latency': 0}, class_id
        inv_data = await res.json()
        invite_token = inv_data["token"]

    print("3. Enrolling 1000 Students...")
    semaphore = asyncio.Semaphore(100)
    cf_blocked_count = 0

    async def enroll_student_1k(s_idx):
        nonlocal cf_blocked_count
        random_str = ''.join(random.choices(string.ascii_letters, k=6))
        payload = {
            "firstName": "Test",
            "lastName": f"Student{s_idx}",
            "username": f"bm_1k_{int(time.time())}_{s_idx}_{random_str}",
            "email": f"bm_1k_{int(time.time())}_{s_idx}_{random_str}@example.com",
            "password": "Password123!"
        }
        async with semaphore:
            start_t = time.time()
            async with aiohttp.ClientSession(headers=BROWSER_HEADERS) as isolated_session:
                async with isolated_session.post(f"{base_url}/api/invitations/{invite_token}", json=payload) as res:
                    body = await res.read()
                    elapsed = time.time() - start_t
                    if is_cloudflare_block(res.status, body):
                        cf_blocked_count += 1
                        return elapsed, False, True
                    return elapsed, res.status == 200, False

    enroll_start_time = time.time()
    results = await tqdm_asyncio.gather(*[enroll_student_1k(s) for s in range(1000)], desc="Enrolling 1000 students")
    enroll_duration = time.time() - enroll_start_time

    enroll_times = [r[0] for r in results]
    success_count = sum(1 for r in results if r[1])

    if cf_blocked_count > 0:
        print(f"\n  [WARNING] {cf_blocked_count} / 1000 enrollment requests blocked by Cloudflare!")

    print(f"\n  [VERIFY] Reading back class to confirm student count...")
    async with session.get(f"{base_url}/api/classes/{class_id}") as res:
        body = await res.read()
        if is_cloudflare_block(res.status, body):
            print("  [VERIFY BLOCKED] Verification read blocked by Cloudflare!")
        elif res.status == 200:
            try:
                cls = await res.json()
                actual_students = len(cls.get("students", cls.get("enrollments", [])))
                print(f"  [VERIFY] Server reports {actual_students} students in class (expected ~{success_count})")
                if actual_students < success_count * 0.9:
                    print(f"  [VERIFY WARNING] Significant discrepancy — only {actual_students}/{success_count} persisted!")
            except Exception:
                print(f"  [VERIFY] Could not parse class response as JSON")
        else:
            print(f"  [VERIFY] Class read returned status {res.status}")

    summary = {
        'success': success_count,
        'failed': 1000 - success_count,
        'cf_blocked': cf_blocked_count,
        'duration': enroll_duration,
        'throughput': len(results) / enroll_duration if enroll_duration > 0 else 0,
        'avg_latency': sum(enroll_times)/len(enroll_times) if enroll_times else 0,
        'max_latency': max(enroll_times) if enroll_times else 0,
        'min_latency': min(enroll_times) if enroll_times else 0,
    }
    return summary, class_id

async def run_sizes_sweep(base_url, identifier, password, concurrency, requests, data_path, plot_name):
    # Group A (volume scaling): fixed 5 topics, subtopics ramp log-spaced 50→5000
    # Group B (ratio effect):   fixed 1000 total items, topic:subtopic ratio varies
    # (5, 200) is the bridge point shared by both groups
    sizes = [
        (5, 10),      #    50 total — Group A
        (5, 50),      #   250 total — Group A
        (5, 200),     # 1,000 total — Group A + B (bridge)
        (5, 500),     # 2,500 total — Group A
        (5, 1000),    # 5,000 total — Group A
        (10, 100),    # 1,000 total — Group B
        (25, 40),     # 1,000 total — Group B
        (50, 20),     # 1,000 total — Group B
        (100, 10),    # 1,000 total — Group B
    ]

    all_summaries = []

    loaded_from_cache = False
    if os.path.exists(data_path):
        print(f"\n  Found existing data file at {data_path}. Loading results...")
        with open(data_path, 'r') as f:
            all_summaries = json.load(f)
        if all_summaries and len(all_summaries) == len(sizes):
            plot_results(sizes, all_summaries, plot_name)
            loaded_from_cache = True
        else:
            print(f"  [WARN] Cached data has {len(all_summaries)}/{len(sizes)} entries — deleting stale file and re-running.")
            os.remove(data_path)
            all_summaries = []

    if not loaded_from_cache:
        print(f"\n  Starting sweep across {len(sizes)} size configurations...")

        for (num_topics, num_subtopics) in sizes:
            total_items = num_topics * num_subtopics

            print(f"\n=======================================================")
            print(f"  CONFIGURATION: {num_topics} Topics, {num_subtopics} Subtopics ({total_items} items total)")
            print(f"=======================================================")

            summary = await run_single_size_test(
                base_url, identifier, password, concurrency, requests, num_topics, num_subtopics
            )
            if not summary:
                print(f"Error occurred during test of size {total_items}. Skipping remaining...")
                break

            all_summaries.append(summary)

            print(f"\n--- SUMMARY FOR CONFIGURATION ({total_items} items) ---")
            for ep, st in summary.items():
                print(f"  [{ep}] Avg Latency: {st['avg_latency']:.4f}s | Throughput: {st['throughput']:.2f} req/s")

            await asyncio.sleep(2)

        print(f"\n  Saving results to {data_path}...")
        with open(data_path, 'w') as f:
            json.dump(all_summaries, f, indent=4)

        if all_summaries and len(all_summaries) == len(sizes):
            plot_results(sizes, all_summaries, plot_name)

    print("\n=======================================================")
    print("  FINAL BENCHMARK STATS")
    print("=======================================================\n")

    pt = PrettyTable()
    pt.field_names = ["Size (Topics x Subtopics)", "Endpoint", "Avg Latency (s)", "Max Latency (s)", "Throughput (req/s)"]

    for idx, (num_topics, num_subtopics) in enumerate(sizes):
        if idx >= len(all_summaries):
            break
        summary = all_summaries[idx]
        size_str = f"{num_topics} x {num_subtopics}"
        for ep, st in summary.items():
            pt.add_row([
                size_str,
                ep,
                f"{st['avg_latency']:.4f}",
                f"{st['max_latency']:.4f}",
                f"{st['throughput']:.2f}"
            ])

    print(pt)

    print("\n--- RUNNING 1000 STUDENTS WRITE TEST ---")
    cookie_jar = aiohttp.CookieJar(unsafe=True)
    async with aiohttp.ClientSession(cookie_jar=cookie_jar, headers=BROWSER_HEADERS) as session:
        logged_in = await login(session, base_url.rstrip('/'), identifier, password)
        if logged_in:
            final_1k_summary, final_class_id = await run_1000_students_write_test(session, base_url.rstrip('/'))

            print("\n--- 1000 Concurrent Student Write DB Test ---")
            pt_1k = PrettyTable()
            pt_1k.field_names = ["Metric", "Value"]
            pt_1k.add_row(["Total Students Enrolled", 1000])
            pt_1k.add_row(["Success Count", final_1k_summary['success']])
            pt_1k.add_row(["Failed Count", final_1k_summary['failed']])
            pt_1k.add_row(["Cloudflare Blocked", final_1k_summary.get('cf_blocked', 0)])
            pt_1k.add_row(["Total Duration (s)", f"{final_1k_summary['duration']:.2f}"])
            pt_1k.add_row(["Throughput (req/sec)", f"{final_1k_summary['throughput']:.2f}"])
            pt_1k.add_row(["Avg Latency (s)", f"{final_1k_summary['avg_latency']:.4f}"])
            pt_1k.add_row(["Min Latency (s)", f"{final_1k_summary['min_latency']:.4f}"])
            pt_1k.add_row(["Max Latency (s)", f"{final_1k_summary['max_latency']:.4f}"])
            print(pt_1k)

            if final_class_id:
                await cleanup_test_data(session, base_url.rstrip('/'), [final_class_id], [])
        else:
            print("Failed to login for final 1000 students test!")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Multi-size Benchmark & Plotting")
    parser.add_argument("--url", default="http://localhost:3000")
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("-c", "--concurrency", type=int, default=50, help="Concurrent connections per endpoint")
    parser.add_argument("-n", "--requests", type=int, default=500, help="Total requests per endpoint per configuration")
    parser.add_argument("--data-path", default="./benchmark/benchmark_results.json", help="Path to save or load the JSON benchmark data")
    parser.add_argument("--plot-name", default="./benchmark/benchmark_effects_plot.png", help="The output filename for the generated plot")
    
    args = parser.parse_args()
    asyncio.run(run_sizes_sweep(args.url, args.username, args.password, args.concurrency, args.requests, args.data_path, args.plot_name))
