#!/bin/bash
set -e
BASE=http://localhost:8118

echo "== 1. 准备字典 =="
curl -s -X POST $BASE/admin/paper-batches -H 'Content-Type: application/json' \
  -d '{"batch_no":"PB-001","material":"棉纸","supplier":"甲"}' >/dev/null
curl -s -X POST $BASE/admin/frame-specs -H 'Content-Type: application/json' \
  -d '{"spec_code":"FS-A","shape":"圆筒","diameter_mm":200,"height_mm":300}' >/dev/null
curl -s -X POST $BASE/admin/stations -H 'Content-Type: application/json' \
  -d '{"code":"ST-1","name":"一号台","location":"东厂"}' >/dev/null
curl -s -X POST $BASE/admin/workers -H 'Content-Type: application/json' \
  -d '{"employee_no":"W-1","name":"小王","role":"craftsman"}' >/dev/null

echo "== 2. 创建灯罩 + 启动流程 =="
curl -s -X POST $BASE/shades -H 'Content-Type: application/json' \
  -d '{"shade_no":"SH-001","frame_spec_id":1,"paper_batch_id":1,"station_id":1,"owner_id":1,"inspect_cycle_hours":24}'
echo
curl -s -X POST $BASE/shades/1/start-flow
echo

echo "== 3. 跳步骤：未成型直接裱贴（应 409）=="
curl -s -o /tmp/r.txt -w "HTTP=%{http_code}\n" -X POST $BASE/shades/1/lamination \
  -H 'Content-Type: application/json' -d '{"layers":2}'
cat /tmp/r.txt; echo

echo "== 4. 跳步骤：未裱贴直接巡检（应 409）=="
curl -s -o /tmp/r.txt -w "HTTP=%{http_code}\n" -X POST $BASE/shades/1/inspection \
  -H 'Content-Type: application/json' -d '{"conclusion":"可交付"}'
cat /tmp/r.txt; echo

echo "== 5. 正常流程：成型 -> 裱贴 -> 巡检（结论=继续观察，不应判可交付）=="
curl -s -X POST $BASE/shades/1/forming -H 'Content-Type: application/json' \
  -d '{"worker_id":1,"frame_correction":"调圆"}' >/dev/null
curl -s -X POST $BASE/shades/1/lamination -H 'Content-Type: application/json' \
  -d '{"worker_id":1,"layers":3,"drying_hours":4,"wrinkle_severity":0}' >/dev/null
curl -s -X POST $BASE/shades/1/inspection -H 'Content-Type: application/json' \
  -d '{"worker_id":1,"light_uniformity":"均匀","light_grade":"A","conclusion":"继续观察"}' >/dev/null

curl -s "$BASE/shades/1" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print('current_state=',d['current_state'])"

echo "== 6. overdue-inspections：刚到待巡检不应被列为超期 =="
curl -s $BASE/analytics/overdue-inspections

echo
echo "== 7. rework-pending-conclusion：调用应 200，不报错 =="
curl -s -o /tmp/r.txt -w "HTTP=%{http_code}\n" $BASE/analytics/rework-pending-conclusion
cat /tmp/r.txt
