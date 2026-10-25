# Bài thực hành API Gateway

Bản đơn giản: Node.js/Express làm gateway, hai service dùng dữ liệu mẫu trong bộ nhớ, MinIO lưu ảnh. Không cần database. Gateway tự viết bằng Express thay cho Nginx để dễ đọc phần JWT và gộp dữ liệu.

Đọc [GIAI_THICH.md](GIAI_THICH.md) để hiểu đề bài, luồng request và vai trò của từng file code.

```text
Client ── JWT ──> Gateway :8080 ── /users ──> User service :3001
                    │          └─ /orders ─> Order service :3002
                    └─ /dashboard: gọi song song cả hai service

Client ── xin URL qua gateway ──> User service ký URL (300 giây)
Client ── PUT ảnh bằng URL đó ──> MinIO :9000 (không qua gateway)
```

## 1. Chạy hệ thống

Cài và mở **Docker Desktop** (Linux containers), sau đó chạy trong thư mục này:

```powershell
docker compose up --build -d --wait
docker compose ps
```

Nếu PowerShell báo không nhận diện `docker` với bản Docker Desktop cài theo user như máy hiện tại, khai báo hàm này rồi chạy lại các lệnh trên:

```powershell
function docker { & "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe" @args }
```

User service tự tạo bucket private `avatars` khi MinIO sẵn sàng. MinIO được build từ mã nguồn chính thức bằng `minio/Dockerfile` vì image registry cũ không tải được. Lần đầu cần Internet và mất vài phút để tải image, thư viện và biên dịch; các lần sau dùng build cache.

| Thành phần | Địa chỉ |
|---|---|
| API Gateway | http://localhost:8080 |
| User service, gọi thẳng để đo | http://localhost:3001 |
| Order service, gọi thẳng để đo | http://localhost:3002 |
| MinIO S3 API | http://localhost:9000 |
| MinIO Console | http://localhost:9001 |

MinIO đăng nhập bằng `minioadmin` / `minioadmin123`. Đây là thông tin mẫu cho bài thực hành.

Xem log và dừng:

```powershell
docker compose logs -f
docker compose down
```

Volume giữ ảnh qua lần khởi động lại. User/Order là dữ liệu mẫu cố định.

## 2. Đăng nhập lấy JWT

Dùng PowerShell, giữ các biến bên dưới cho các bước tiếp theo:

```powershell
$base = 'http://localhost:8080'
$login = Invoke-RestMethod -Method Post -Uri "$base/auth/login" -ContentType 'application/json' -Body '{"username":"alice","password":"123456"}'
$headers = @{ Authorization = "Bearer $($login.token)" }
$login
```

Hai tài khoản mẫu: `alice` (userId 1), `bob` (userId 2), cùng mật khẩu `123456`. JWT HS256 hết hạn sau 1 giờ. Gateway kiểm tra chữ ký, thuật toán, hạn dùng, issuer và audience.

## 3. Routing và Aggregation

```powershell
Invoke-RestMethod "$base/users" -Headers $headers
Invoke-RestMethod "$base/users/1" -Headers $headers
Invoke-RestMethod "$base/orders" -Headers $headers
Invoke-RestMethod "$base/dashboard" -Headers $headers | ConvertTo-Json -Depth 5
```

`/dashboard` trả user Alice, hai đơn hàng 101/102, `totalOrders: 2`, `totalAmount: 750000`. Đổi sang Bob sẽ có một đơn hàng 103 trị giá 3000000.

Gateway lấy userId từ JWT, ghi đè `X-User-Id` và tham số lọc đơn hàng do client gửi. Alice gọi `/users/2` nhận `403`; thêm `?userId=2` vào `/orders` hoặc `/dashboard` vẫn chỉ nhận đơn của Alice. `/users` qua gateway trả danh sách chứa user hiện tại.

| Endpoint gateway | JWT | Chức năng |
|---|---|---|
| `GET /health` | Không | Kiểm tra hoạt động, miễn rate limit |
| `POST /auth/login` | Không | Lấy JWT bằng tài khoản mẫu |
| `GET /users` | Có | Chuyển tới User service |
| `GET /users/:id` | Có | Thông tin user hiện tại |
| `GET /orders` | Có | Chuyển tới Order service, lọc theo JWT |
| `GET /dashboard` | Có | Gọi hai service song song và gộp JSON |
| `POST /users/:id/avatar-upload-url` | Có | Xin URL upload ảnh |

## 4. Valet Key: upload ảnh đại diện

Đặt một ảnh `avatar.png` trong thư mục hiện tại, rồi chạy:

```powershell
$upload = Invoke-RestMethod -Method Post -Uri "$base/users/1/avatar-upload-url" -Headers $headers -ContentType 'application/json' -Body '{"contentType":"image/png"}'
$upload | Format-List
Invoke-WebRequest -Method Put -Uri $upload.uploadUrl -InFile '.\avatar.png' -ContentType 'image/png'
```

Mở MinIO Console, chọn bucket `avatars`, tìm object theo `$upload.objectName`. Có thể dùng `image/jpeg` hoặc `image/webp` với ảnh tương ứng.

URL cho phép **PUT vào đúng một object**, hết hạn sau **300 giây kể từ lúc ký**; upload trực tiếp tới MinIO, không gửi JWT hay khóa MinIO trong bước PUT. Không đổi hostname, path hoặc query của URL vì chúng tham gia chữ ký. Sau 5 phút, PUT lại URL cũ sẽ bị MinIO từ chối. URL có thể dùng lại trong thời hạn này; không phải khóa dùng một lần.

Bài thực hành lưu ảnh dưới thư mục user trong MinIO; chưa cập nhật hồ sơ user hay xây giao diện hiển thị ảnh. Bucket private nên URL object không có chữ ký không cho phép đọc công khai. Trường `contentType` được kiểm tra khi xin URL; bản đơn giản này không kiểm tra nội dung nhị phân của file.

## 5. Kiểm tra JWT và giới hạn 10 request/giây

Không gửi token sẽ nhận `401`:

```powershell
curl.exe -i http://localhost:8080/users
```

Gateway cho tối đa **10 request trong bất kỳ cửa sổ 1 giây nào cho mỗi IP**, tính cả đăng nhập và request thiếu/sai JWT. Request vượt mức nhận `429` cùng header `Retry-After`. `/health` được miễn. Bộ đếm nằm trong bộ nhớ của một gateway.

Gửi nhanh 11 request (dừng các chương trình khác đang gọi gateway để kết quả dễ quan sát):

```powershell
Start-Sleep -Milliseconds 1100
1..11 | ForEach-Object { curl.exe -s -o NUL -w '%{http_code}\n' -H "Authorization: Bearer $($login.token)" "$base/orders" }
```

Nếu 11 lệnh hoàn thành trong một giây: 10 lần `200`, lần tiếp theo `429`. Máy chạy chậm có thể khiến vòng lặp kéo dài hơn một giây; dùng smoke test bên dưới để gửi đồng thời.

## 6. Đo độ trễ: gọi thẳng và qua gateway

Chạy benchmark ngay trong container gateway, không cần cài Node.js trên máy:

```powershell
docker compose exec gateway npm run benchmark
New-Item -ItemType Directory -Force results | Out-Null
docker compose cp gateway:/app/results/benchmark.json ./results/benchmark.json
```

Hoặc nếu có Node.js 22+ trên máy:

```powershell
npm ci
npm run benchmark
```

Script đo cả User và Order, mỗi service 30 mẫu cho mỗi đường gọi sau 5 lượt làm nóng. Mỗi cặp gọi trả cùng dữ liệu, đảo thứ tự đo và nghỉ 130ms để không vượt rate limit. Không tắt JWT hoặc rate limit khi đo. Độ trễ bao gồm nhận hết response body, dùng kết nối HTTP được tái sử dụng của `fetch`.

Kết quả gồm trung bình, p50, p95, chênh lệch trung bình và các mẫu thô trong `results/benchmark.json`:

```text
Chênh lệch trung bình = trung bình qua gateway - trung bình gọi thẳng
```

Số đo phụ thuộc máy, tải, mạng Docker và vị trí chạy script. Kết quả chạy trong container và trên host là hai bối cảnh khác nhau; ghi rõ bối cảnh khi đưa vào báo cáo. Mẫu nhỏ có thể có chênh lệch âm do nhiễu. File kết quả được tạo bằng phép đo thực tế khi chạy script, không có số liệu giả lập sẵn.

Kết quả đã đo trên Docker Desktop ngày 26/10/2026: User, Order và Gateway chạy trong các container riêng; script chạy trong container gateway, 100 mẫu/service sau 5 lượt làm nóng:

| Service | Gọi thẳng, trung bình (ms) | Qua gateway, trung bình (ms) | Chênh lệch (ms) |
|---|---:|---:|---:|
| User | 2.468 | 5.549 | +3.081 |
| Order | 2.681 | 6.009 | +3.328 |

Đây là số đo của lần chạy trên máy hiện tại. Mẫu thô và cấu hình môi trường nằm trong `results/benchmark.json`; bối cảnh phép đo nằm trong `results/context.md`. Upload PNG thật lên MinIO, bucket private và rate limit đã được kiểm tra bằng smoke test.

Đổi số mẫu, ví dụ 100:

```powershell
docker compose exec -e SAMPLES=100 gateway npm run benchmark
```

## 7. Kiểm thử

Chạy bộ kiểm thử trong Docker, không cần cài Node.js trên máy:

```powershell
docker compose exec -T gateway npm test
```

Với Node.js 22+ trên máy:

```powershell
npm ci
npm test
```

Kiểm thử khởi động ba HTTP server trên cổng ngẫu nhiên: JWT, routing, chống giả mạo userId, dashboard, rate limit, lỗi upstream và URL ký bằng MinIO SDK với `X-Amz-Expires=300`. Không cần MinIO cho nhóm kiểm thử này; việc nhận file thật được kiểm tra riêng bằng smoke test.

Sau khi Docker Compose đang chạy, chạy smoke test **trên máy host** để URL `localhost:9000` trỏ đúng MinIO:

```powershell
npm run smoke
```

Smoke test kiểm tra JWT, dashboard, upload ảnh PNG mẫu thật bằng URL ký sẵn, bucket private và 11 request đồng thời. Test tạo một ảnh nhỏ trong MinIO. Smoke test xác nhận TTL trong URL; kiểm tra việc hết hạn theo thời gian thực bằng cách đợi hơn 5 phút và PUT lại URL như mục 4.

Hoặc tự động đợi và kiểm tra URL cũ đã hết hạn:

```powershell
npm run smoke -- --wait-expiry
```

Script ghi kết quả vào `results/smoke.json`, không lưu JWT hay URL ký sẵn vào báo cáo.

## 8. Kết quả đã kiểm tra ngày 26/10/2026

| Nội dung | Kết quả |
|---|---|
| Khởi động Docker Compose | Đủ Gateway, User, Order và MinIO |
| Bộ kiểm thử HTTP trong container | 6/6 nhóm thành công |
| Không gửi JWT | HTTP 401 |
| Dashboard Alice | User 1, hai đơn hàng, tổng 750000 |
| 11 request đồng thời trong cửa sổ 1 giây | 10 lần HTTP 200, 1 lần HTTP 429 |
| Upload PNG trực tiếp bằng URL ký sẵn | HTTP 200; đọc lại object xác nhận đúng dữ liệu PNG |
| Đọc ảnh ẩn danh trong bucket private | HTTP 403 |
| PUT lại nguyên URL sau hơn 5 phút | HTTP 403, `Request has expired` |
| Đo độ trễ giữa các container | 100 mẫu/service, số liệu tại mục 6 |

Các file kết quả trên máy: `results/smoke.json`, `results/benchmark.json`, `results/context.md`. Ảnh đã đọc lại từ MinIO lưu ở `results/uploaded-avatar.png`. Thư mục `results/` đang được bỏ qua trong Git; nếu cần nộp kèm thì copy các file này vào gói bài nộp. Bảng kết quả trong README vẫn được giữ cùng source code.

## Giới hạn của bản thực hành

Service không tự kiểm tra JWT; đó là trách nhiệm gateway (offloading). Các cổng gọi thẳng chỉ bind vào loopback của máy để phục vụ bài đo. Khi triển khai thật cần bỏ cổng public của service và buộc lưu lượng qua gateway, thay tài khoản demo, bảo vệ mật khẩu, dùng HTTPS và chia sẻ bộ đếm nếu có nhiều gateway.

Tài liệu tham khảo: [Express](https://expressjs.com/en/guide/migrating-5/), [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken#readme), [MinIO presignedPutObject](https://github.com/minio/minio-js/blob/master/docs/API.md#presignedputobjectbucketname-objectname-expiry-callback).
