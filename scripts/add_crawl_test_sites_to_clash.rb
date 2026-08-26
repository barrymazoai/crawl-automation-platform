require "fileutils"

base = "/Users/songtianjian/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev"
profile_rules = File.join(base, "profiles", "rcv31wHZ05Ux.yaml")
generated_config = File.join(base, "clash-verge.yaml")
target = "AI/X专用"

domains = %w[
  mindbodygreen.com
  hellobonafide.com
  solgar.com
  thorne.com
]
rules = domains.map { |domain| "DOMAIN-SUFFIX,#{domain},#{target}" }
timestamp = Time.now.strftime("%Y%m%d-%H%M%S")

[profile_rules, generated_config].each do |path|
  abort "Missing #{path}" unless File.file?(path)
  FileUtils.cp(path, "#{path}.bak-crawl-test-sites-#{timestamp}")
end

profile = File.read(profile_rules)
domains.each do |domain|
  key = Regexp.escape("DOMAIN-SUFFIX,#{domain}")
  profile.gsub!(/^\s*-\s*'#{key},[^']+'\n/, "")
end
profile_block = rules.map { |rule| "  - '#{rule}'" }.join("\n") + "\n"
unless profile.sub!(/^  - 'DOMAIN-SUFFIX,claude\.ai,AI\/X专用'\n/, "\\0#{profile_block}")
  abort "Could not find AI/X prepend anchor in #{profile_rules}"
end
File.write(profile_rules, profile)

generated = File.read(generated_config)
domains.each do |domain|
  key = Regexp.escape("DOMAIN-SUFFIX,#{domain}")
  generated.gsub!(/^\s*-\s*#{key},[^\n]+\n/, "")
end
generated_block = rules.map { |rule| "- #{rule}" }.join("\n") + "\n"
unless generated.sub!(/^- DOMAIN-SUFFIX,claude\.ai,AI\/X专用\n/, "\\0#{generated_block}")
  abort "Could not find AI/X generated anchor in #{generated_config}"
end
File.write(generated_config, generated)

puts "updated #{profile_rules}"
puts "updated #{generated_config}"
puts "target #{target}"
puts "added:"
rules.each { |rule| puts "  #{rule}" }
puts "backup suffix .bak-crawl-test-sites-#{timestamp}"
