package main

func main() {
	router := gin.Default()
	router.GET("/api/ping", ping)
	router.POST("/api/orders", createOrder)
}
