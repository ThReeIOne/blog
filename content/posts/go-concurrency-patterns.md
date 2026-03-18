---
title: "Go 并发编程：从 Goroutine 到高级模式"
date: "2026-03-10"
tags: ["Go", "并发", "后端"]
---

# Go 并发编程：从 Goroutine 到高级模式

Go 的并发模型是其最强大的特性之一。本文深入探讨 Goroutine、Channel 以及常见并发模式的实战应用。

## Goroutine 的本质

Goroutine 是 Go 运行时调度的轻量级线程，启动成本极低（初始栈约 2KB），可以轻松启动数百万个。

```go
func main() {
    for i := 0; i < 1000000; i++ {
        go func(n int) {
            // 每个 goroutine 独立执行
        }(i)
    }
}
```

## Channel：通信而非共享内存

> Do not communicate by sharing memory; instead, share memory by communicating.

```go
func producer(ch chan<- int) {
    for i := 0; i < 10; i++ {
        ch <- i
    }
    close(ch)
}

func consumer(ch <-chan int, done chan<- struct{}) {
    for v := range ch {
        fmt.Println(v)
    }
    done <- struct{}{}
}
```

## Pipeline 模式

Pipeline 是将多个处理阶段通过 Channel 串联起来的模式：

```go
func generate(nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        for _, n := range nums {
            out <- n
        }
        close(out)
    }()
    return out
}

func square(in <-chan int) <-chan int {
    out := make(chan int)
    go func() {
        for n := range in {
            out <- n * n
        }
        close(out)
    }()
    return out
}

func main() {
    c := generate(2, 3, 4)
    out := square(square(c))
    for v := range out {
        fmt.Println(v) // 16, 81, 256
    }
}
```

## Worker Pool

```go
func workerPool(jobs <-chan int, results chan<- int, numWorkers int) {
    var wg sync.WaitGroup
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for j := range jobs {
                results <- j * j
            }
        }()
    }
    wg.Wait()
    close(results)
}
```

## Context：优雅取消

```go
func doWork(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            time.Sleep(100 * time.Millisecond)
        }
    }
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()
    if err := doWork(ctx); err != nil {
        log.Println("cancelled:", err)
    }
}
```

并发编程的核心原则：**能用 Channel 解决的，尽量不用 Mutex**；需要共享状态时，用 `sync.Mutex` 或 `sync/atomic` 保护。
