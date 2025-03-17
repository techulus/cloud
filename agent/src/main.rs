use tokio::{signal, time::{sleep, Duration}};
use reqwest::Client;

async fn perform_task(client: &Client) {
    let url = "https://example.com/api";
    match client.get(url).send().await {
        Ok(response) => {
            if let Ok(body) = response.text().await {
                println!("Received response: {}", body);
            }
        }
        Err(err) => eprintln!("Request failed: {}", err),
    }
}

#[tokio::main]
async fn main() {
    let client = Client::new();

    let task_loop = tokio::spawn(async move {
        loop {
            perform_task(&client).await;
            sleep(Duration::from_secs(5)).await;
        }
    });

    let shutdown_signal = async {
        signal::ctrl_c().await.expect("Failed to install Ctrl+C handler");
    };

    tokio::select! {
        _ = shutdown_signal => {
            println!("Shutting down agent...");
        }
        _ = task_loop => {}
    }
}