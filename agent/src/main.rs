use bollard::{
    container::ListContainersOptions,
    image::ListImagesOptions,
    network::ListNetworksOptions,
    secret::{ContainerSummary, ImageSummary, Network},
    Docker, API_DEFAULT_VERSION,
};
use reqwest::Client;
use serde_json::json;
use tokio::{
    signal,
    time::{sleep, Duration},
};

async fn send_status_update(
    containers: &Vec<ContainerSummary>,
    images: &Vec<ImageSummary>,
    networks: &Vec<Network>,
) {
    let client = Client::new();

    let url = "http://localhost:3000/api/v1/agent/status";

    let body = json!({
        "containers": containers,
        "images": images,
        "networks": networks,
    });

    match client
        .post(url)
        .header("Content-Type", "application/json")
        .header("x-agent-token", "10dbcfc6-9e9b-478f-be81-bbd8b1df176e")
        .body(body.to_string())
        .send()
        .await
    {
        Ok(response) => {
            if let Ok(body) = response.text().await {
                println!("Received response: {}", body);
            }
        }
        Err(err) => eprintln!("Request failed: {}", err),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let docker = Docker::connect_with_socket(
        "/Users/arjunkomath/.docker/run/docker.sock",
        120,
        API_DEFAULT_VERSION,
    )?;

    let task_loop = tokio::spawn(async move {
        loop {
            let containers = &docker
                .list_containers(Some(ListContainersOptions::<String> {
                    all: true,
                    ..Default::default()
                }))
                .await
                .unwrap();

            let images = &docker
                .list_images(Some(ListImagesOptions::<String> {
                    all: true,
                    ..Default::default()
                }))
                .await
                .unwrap();

            let networks = &docker
                .list_networks(Some(ListNetworksOptions::<String> {
                    ..Default::default()
                }))
                .await
                .unwrap();

            send_status_update(containers, images, networks).await;
            sleep(Duration::from_secs(15)).await;
        }
    });

    let shutdown_signal = async {
        signal::ctrl_c()
            .await
            .expect("Failed to install Ctrl+C handler");
    };

    tokio::select! {
        _ = shutdown_signal => {
            println!("Shutting down agent...");
        }
        _ = task_loop => {}
    }

    Ok(())
}
