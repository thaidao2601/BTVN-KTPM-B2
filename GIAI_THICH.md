# Giải thích bài tập theo từng file

## 1. Hiểu đề bài bằng một ví dụ

Giả sử Alice mở trang tài khoản của mình. Trang cần tên/email từ User service và danh sách mua hàng từ Order service. Client gọi một cửa vào là API Gateway.

Gateway kiểm tra Alice đã đăng nhập chưa, hạn chế số lần gọi và chuyển request tới service phù hợp. Khi Alice gọi `/dashboard`, gateway tự lấy cả hai nguồn rồi ghép thành một JSON. Khi Alice tải ảnh đại diện, gateway chỉ giúp xin một URL có quyền upload tạm thời; file ảnh đi thẳng vào MinIO.

| Yêu cầu | Cách làm trong bài | File chính |
|---|---|---|
| Routing | `/users...` tới User, `/orders...` tới Order | `gateway.js` |
| Offloading | Gateway kiểm tra JWT và giới hạn 10 request/giây/IP | `gateway.js` |
| Aggregation | `/dashboard` ghép user và đơn hàng của user đó | `gateway.js` |
| Valet Key | URL cho phép PUT một ảnh, hết hạn sau 300 giây | `user-service.js` |
| So sánh độ trễ | Đo cùng dữ liệu qua hai đường gọi HTTP | `scripts/benchmark.js` |

```text
                                  ┌─ User service :3001
Client → API Gateway :8080 ────────┤
                                  └─ Order service :3002

Client → Gateway → User service → nhận URL ký sẵn
Client ── PUT ảnh bằng URL ──────→ MinIO :9000
```

Trong bài này API Gateway là ứng dụng Express. Đề ghi Nginx là ví dụ, nên có thể dùng Express để thực hiện cùng các nhiệm vụ và đọc code thuận tiện.

## 2. `compose.yaml`: khởi động và kết nối các thành phần

File này khai báo bốn container: `gateway`, `user-service`, `order-service`, `minio`. Hai container User/Order là hai service nghiệp vụ; MinIO là nơi lưu file.

Ví dụ cấu hình của gateway:

```yaml
environment:
  USER_SERVICE_URL: http://user-service:3001
  ORDER_SERVICE_URL: http://order-service:3002
```

Các container cùng mạng Docker gọi nhau bằng **tên service**. Vì vậy gateway dùng `user-service:3001`, không dùng `localhost:3001`. `localhost` bên trong container chỉ chính container đó.

`ports` nối cổng container ra máy của bạn. Bạn gọi `localhost:8080` trên Windows để tới gateway. Các cổng bind `127.0.0.1` nên dùng cho máy cục bộ. Cổng 3001/3002 được mở để làm phép đo gọi thẳng.

`depends_on` kèm `service_healthy` giúp gateway đợi User và Order sẵn sàng. `healthcheck` gọi `/health` định kỳ. `minio-data` là volume giữ ảnh khi dừng rồi chạy lại container; không phải database của User/Order.

## 3. `Dockerfile`: đóng gói ứng dụng Node.js

Đọc lần lượt:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "gateway.js"]
```

Docker lấy môi trường Node.js, tạo thư mục `/app`, cài thư viện đúng theo lockfile rồi chép code vào image. Copy file package trước giúp Docker tái sử dụng bước cài thư viện khi bạn chỉ sửa code.

User và Order dùng chung Dockerfile nhưng `command` trong Compose thay lệnh mặc định thành `node user-service.js` và `node order-service.js`. Mỗi container vẫn chạy ứng dụng của riêng mình.

### `minio/Dockerfile`

File riêng này dùng Go để biên dịch MinIO từ bản mã nguồn đã cố định, rồi chỉ chép chương trình đã biên dịch sang image Alpine nhỏ hơn. Đây là build hai giai đoạn: container chạy MinIO không cần chứa bộ công cụ Go.

Image MinIO cũ trong registry không tải được, nên bài dùng cách build từ mã nguồn theo [hướng dẫn MinIO](https://github.com/minio/minio#source-only-distribution). Bạn vẫn chạy một lệnh Compose; lần build đầu cần nhiều thời gian hơn.

## 4. `shared.js`: phần dùng chung

Ba ứng dụng đều dùng file này:

| Hàm | Ý nghĩa |
|---|---|
| `createApp(service)` | Tạo Express app, đọc JSON và thêm `GET /health` |
| `finishApp(app)` | Trả JSON 404 cho đường dẫn không tồn tại và xử lý lỗi |
| `fetchService(url, options)` | Gọi HTTP tới service, timeout 3 giây; lỗi kết nối thành HTTP 502 |

Giới hạn JSON `16kb` dành cho dữ liệu nhỏ như thông tin đăng nhập. File ảnh không gửi qua JSON này; ảnh đi trực tiếp vào MinIO.

## 5. `gateway.js`: phần trọng tâm

### a. Khởi tạo gateway

`createGateway()` lấy địa chỉ hai service và khóa JWT từ biến môi trường. Khi chạy file trực tiếp, gateway nghe cổng 8080. Khi test, hàm trả app để test tự chọn một cổng trống.

### b. Giới hạn 10 request/giây

Middleware rate limit lưu mốc thời gian request theo IP trong một `Map`. Mỗi request mới sẽ loại các mốc quá 1 giây. Nếu vẫn còn 10 mốc trong cửa sổ đó, request mới bị trả `429 Too Many Requests`; nếu chưa đủ thì ghi nhận mốc mới và cho đi tiếp.

Ví dụ IP của bạn đã gửi 10 request từ 10:00:00.200 tới 10:00:00.900. Request lúc 10:00:01.000 vẫn bị chặn vì cửa sổ một giây gần nhất vẫn chứa cả 10 request. Đây là cửa sổ trượt, không reset theo đầu giây trên đồng hồ.

Giới hạn áp dụng chung cho các API, kể cả đăng nhập và thiếu JWT. `/health` được đăng ký trước middleware nên được miễn. Bộ đếm dùng bộ nhớ, phù hợp một gateway trong bài thực hành.

### c. Đăng nhập lấy JWT

`POST /auth/login` kiểm tra tài khoản mẫu Alice hoặc Bob, rồi gọi `jwt.sign()` để phát token. `sub` là ID của người dùng; `expiresIn: '1h'` là thời hạn token. Danh sách tài khoản và mật khẩu được ghi sẵn để bài ngắn gọn.

Client gửi token trong các request tiếp theo:

```http
Authorization: Bearer <token>
```

### d. Kiểm tra JWT — Offloading

Middleware gọi `jwt.verify()` để kiểm tra chữ ký HS256, thời hạn, bên phát hành (`issuer`) và đối tượng nhận (`audience`). Sau đó lấy `payload.sub` làm `req.userId`.

Không có token, token bị sửa hoặc hết hạn thì trả `401`. Service phía sau nhận danh tính đã được gateway kiểm tra qua header `X-User-Id`. Gateway tự tạo header này, không chuyển nguyên header danh tính của client.

Gọi là **offloading** vì các service giao nhiệm vụ xác thực và giới hạn request cho gateway. Trong bài, gọi thẳng service không cần JWT để dễ đo độ trễ; ứng dụng thực tế cần hạn chế đường gọi thẳng này.

### e. `/dashboard` — Aggregation

Với Alice (`req.userId = '1'`), gateway gọi đồng thời:

```text
GET http://user-service:3001/users/1
GET http://order-service:3002/orders?userId=1
```

`Promise.all()` đợi cả hai kết quả. Gateway trả một JSON gồm `user`, `orders`, `totalOrders` và `totalAmount`. Alice có hai đơn tổng 750000; Bob có một đơn tổng 3000000. Nếu một service không kết nối được, request nhận `502`.

Client chỉ gọi một endpoint để lấy dữ liệu từ nhiều service. Đó là **aggregation**. UserId lấy từ token nên thêm `?userId=2` không đổi dashboard của Alice thành của Bob.

### f. Chuyển tiếp request — Routing

Phần cuối nhận diện đường dẫn `/users` hoặc bắt đầu bằng `/users/`, rồi chuyển request sang User service. Tương tự `/orders` chuyển sang Order service. Gateway giữ đường dẫn, method và JSON body cần thiết, rồi chuyển status/body của service về client.

Gateway chặn Alice truy cập `/users/2`. Với `/orders`, gateway ép tham số `userId` về ID trong JWT. Đây là cách đảm bảo trả dữ liệu đúng người.

Thứ tự xử lý phần lớn request:

```text
Đọc JSON → Rate limit → JWT → Dashboard hoặc Routing → Trả JSON
```

## 6. `user-service.js`: dữ liệu user và Valet Key

Mảng `users` chứa hai user mẫu. `GET /users` trả danh sách, có lọc theo `X-User-Id` khi đi qua gateway. `GET /users/:id` tìm một user theo ID.

Endpoint `POST /users/:id/avatar-upload-url` nhận `contentType`, tạo tên object riêng bằng UUID rồi gọi:

```js
signer.presignedPutObject('avatars', objectName, 300)
```

Kết quả là URL có chữ ký và thời hạn **300 giây = 5 phút**. User service có hai client MinIO:

| Client | Địa chỉ | Mục đích |
|---|---|---|
| `internal` | `minio:9000` | Kết nối từ container, kiểm tra/tạo bucket |
| `signer` | `localhost:9000` | Ký URL mà client trên Windows dùng được |

Không đổi hostname của URL sau khi ký vì hostname tham gia chữ ký. Luồng upload gồm hai request riêng:

1. Client gửi JWT tới gateway để xin URL upload.
2. Client gửi `PUT` chứa bytes của ảnh tới URL MinIO vừa nhận; bước này không cần JWT.

Chữ ký cho phép upload đúng object đã chỉ định trong thời hạn cho phép. Sau 5 phút, MinIO từ chối URL cũ. URL có thể dùng lại trước khi hết hạn; không phải URL dùng một lần. Đó là **Valet Key**: cấp quyền tạm thời, giới hạn phạm vi mà không đưa khóa MinIO cho client.

Bucket private nên việc upload thành công không làm ảnh tự trở thành công khai. Bản đơn giản lưu ảnh theo user trong MinIO; không có giao diện và chưa gắn ảnh vào dữ liệu hồ sơ. `contentType` là kiểm tra tham số xin URL, không phải kiểm tra nội dung thật của ảnh.

Khi khởi động, service thử kết nối MinIO và tạo bucket `avatars` nếu chưa có. Chỉ sau bước này mới mở cổng 3001.

## 7. `order-service.js`: dữ liệu đơn hàng

Mảng `orders` có ba đơn mẫu. Mỗi đơn chứa `userId` để xác định chủ sở hữu. `GET /orders` lọc theo `X-User-Id` do gateway gửi, hoặc theo `?userId=...` khi gọi thẳng để đo.

Ví dụ với Alice, hai đơn trả về là bàn phím 500000 và chuột 250000. File này không chứa code JWT hoặc rate limit vì hai việc đó đã được gateway đảm nhiệm.

## 8. `scripts/benchmark.js`: đo độ trễ

Script đăng nhập lấy JWT rồi đo User và Order qua hai đường:

```text
Gọi thẳng:    Benchmark → Service → Benchmark
Qua gateway:  Benchmark → Gateway → Service → Gateway → Benchmark
```

Mỗi service có 5 lượt làm nóng và 30 mẫu đo cho mỗi đường. Script đo từ trước khi `fetch` tới khi nhận hết response body, kiểm tra hai đường trả cùng dữ liệu, đảo thứ tự gọi để giảm ảnh hưởng thứ tự đo và nghỉ 130ms mỗi cặp để không vượt rate limit.

| Chỉ số | Cách hiểu |
|---|---|
| `meanMs` | Thời gian trung bình, đơn vị mili giây |
| `p50Ms` | Mốc mà ít nhất 50% mẫu không vượt quá |
| `p95Ms` | Mốc mà ít nhất 95% mẫu không vượt quá |
| `overheadMeanMs` | Trung bình qua gateway trừ trung bình gọi thẳng |

Nếu chênh lệch là +2ms, qua gateway mất thêm trung bình khoảng 2ms trong lần đo đó. Phần tăng thêm gồm JWT, middleware, một lượt HTTP bổ sung và các bước chuyển tiếp. Một mẫu nhỏ có thể nhiễu; không dùng số đo này làm cam kết hiệu năng cho mọi máy.

Khi chạy trong container gateway, đường gọi qua gateway dùng `localhost:8080`, đường gọi thẳng dùng mạng Docker tới User/Order. Kết quả và các mẫu thô lưu trong `results/benchmark.json`. Xem `results/context.md` để biết bối cảnh của số liệu đã chạy.

## 9. Các file kiểm thử

`tests/system.test.js` dùng Node Test Runner, tự mở ba HTTP app trên cổng ngẫu nhiên. Các nhóm test kiểm tra đăng nhập/JWT, routing/phân quyền, dashboard Alice/Bob, URL MinIO có TTL 300 giây, giới hạn 10 request/giây và lỗi upstream.

`scripts/smoke.js` gọi hệ thống đang chạy để kiểm tra luồng thật. Script xin URL qua gateway, PUT ảnh PNG nhỏ vào MinIO, kiểm tra bucket không cho đọc ẩn danh và gửi 11 request đồng thời để kiểm tra rate limit. Kết quả lưu vào `results/smoke.json`.

Chạy smoke với `--wait-expiry` sẽ giữ nguyên URL, đợi hơn 5 phút rồi PUT lại để xác nhận MinIO trả `403` với thông báo `Request has expired`.

## 10. Các file còn lại

| File | Vai trò |
|---|---|
| `package.json` | Khai báo thư viện `express`, `jsonwebtoken`, `minio` và các lệnh npm |
| `package-lock.json` | Cố định cả phiên bản thư viện phụ thuộc để `npm ci` cài lại nhất quán |
| `.dockerignore` | Không đưa thư viện/caches của máy host vào image |
| `.gitignore` | Bỏ qua thư viện, cache, `.env` và kết quả chạy khi commit Git |
| `README.md` | Các lệnh chạy, đăng nhập, gọi API, upload và đo độ trễ |
| `results/benchmark.json` | Số liệu đo thực tế và mẫu thô |
| `results/smoke.json` | Kết quả kiểm thử hệ thống đang chạy |

## 11. Thứ tự nên đọc và demo

Đọc `compose.yaml` để hình dung bốn container, rồi `shared.js`, `order-service.js`, `user-service.js`, cuối cùng `gateway.js`. Sau khi hiểu request đi đâu, đọc script đo và kiểm thử.

Khi trình bày bài: khởi động Compose → đăng nhập Alice → gọi `/users` và `/orders` → gọi `/dashboard` → gọi thiếu token → gửi 11 request → xin URL và PUT ảnh → trình bày kết quả benchmark. Dùng các lệnh sẵn trong `README.md`.
