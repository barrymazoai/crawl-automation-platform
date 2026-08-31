#!/usr/bin/env ruby

require "json"
require "open3"
require "uri"
require "yaml"

config_file, selector_name, target_name, controller_url = ARGV
abort "usage: set-sales-channel-exit.rb CONFIG_FILE SELECTOR_NAME TARGET_NAME" unless target_name

deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 90
encoded_selector = URI.encode_www_form_component(selector_name).gsub("+", "%20")

def request(socket, curl_config, *arguments)
  output, error, status = Open3.capture3(
    "/usr/bin/curl", "--silent", "--show-error", "--fail", "--max-time", "5", "--noproxy", "*",
    *(socket ? ["--unix-socket", socket] : []), *arguments, "--config", "-",
    stdin_data: curl_config,
  )
  raise(error.strip.empty? ? "clash request failed" : error.strip) unless status.success?
  output
end

# Prefer a dedicated, stable TCP controller when one is supplied. Unix socket
# discovery remains available for interactive/local use and is refreshed on
# every retry because Clash Verge rotates it during profile refresh.
last_runtime_error = nil
loop do
  begin
    config = YAML.load_file(config_file)
    raise "invalid clash config" unless config.is_a?(Hash)
    socket = controller_url ? nil : config["external-controller-unix"]
    raise "external-controller-unix is missing" unless controller_url || socket
    base_url = controller_url ? controller_url.sub(%r{/+$}, "") : "http://localhost"
    secret = config["secret"].to_s
    curl_config = secret.empty? ? "" : "header = \"Authorization: Bearer #{secret}\"\n"
    proxies = JSON.parse(request(socket, curl_config, "#{base_url}/proxies")).fetch("proxies")
    candidate = proxies[selector_name]
    raise "missing selector: #{selector_name}" unless candidate
    raise "target is not a selector member: #{target_name}" unless Array(candidate["all"]).include?(target_name)

    request(
      socket,
      curl_config,
      "--request", "PUT",
      "--header", "Content-Type: application/json",
      "--data", JSON.generate({ name: target_name }),
      "#{base_url}/proxies/#{encoded_selector}",
    )
    runtime = JSON.parse(request(socket, curl_config, "#{base_url}/proxies")).fetch("proxies").fetch(selector_name)
    raise "selector switch failed" unless runtime["now"] == target_name
    puts JSON.generate({ selector: selector_name, selected: runtime["now"] })
    exit 0
  rescue StandardError => error
    next_runtime_error = error.message
    warn next_runtime_error if next_runtime_error != last_runtime_error
    last_runtime_error = next_runtime_error
  end
  abort last_runtime_error if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
  sleep 0.5
end
