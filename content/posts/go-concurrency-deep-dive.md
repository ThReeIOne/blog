---
title: "Go 并发模型深度解析：Goroutine、Channel 与 Select"
date: "2026-03-18"
tags: ["Go", "并发", "后端"]
summary: "深入剖析 Go 语言的并发原语，从 Goroutine 调度器原理到 Channel 通信模式。"
---

Go 的并发模型是它最大的卖点，但很多人只会 `go func()`，不懂底层原理。

## Goroutine 不是线程

Goroutine 是用户态轻量线程，初始栈只有 2KB，可以轻松创建百万个。Go 运行时用 **GMP 模型** 调度：

- **G**：Goroutine，携带栈和上下文
- **M**：OS 线程，真正执行代码  
- **P**：逻辑处理器，持有本地运行队列

## Channel 通信

Go 哲学：不要通过共享内存通信，而要通过通信共享内存。

```go
ch := make(chan int)
go func() { ch <- 42 }()
val := <-ch
```

### Worker Pool 实战

```go
func workerPool(numWorkers int, jobs <-chan int) <-chan int {
    results := make(chan int, numWorkers)
    var wg sync.WaitGroup
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                results <- job * 2
            }
        }()
    }
    go func() {
        wg.Wait()
        close(results)
    }()
    return results
}
```

## Select 多路复用

```go
select {
case job := <-jobs:
    process(job)
case <-ctx.Done():
    return
case <-time.After(5 * time.Second):
    fmt.Println("timeout")
}
```

## 常见陷阱

1. **Goroutine 泄漏**：没有退出机制导致永久阻塞，始终用 context 控制生命周期
2. **关闭已关闭的 Channel**：会 panic，用 `sync.Once` 保护
3. **数据竞争**：多个 goroutine 读写同一变量，用 `-race` flag 检测

| 场景 | 推荐方案 |
|------|---------|
| 简单同步 | 无缓冲 Channel |
| 任务队列 | 有缓冲 Channel |
| 超时控制 | select + time.After |
| 取消传播 | context.Context |
