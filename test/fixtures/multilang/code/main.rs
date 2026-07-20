async fn main() {
    let app = Router::new().route("/api/health", get(health_handler));
}

#[get("/api/legacy")]
async fn legacy() -> impl Responder { HttpResponse::Ok() }
